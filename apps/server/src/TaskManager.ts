import { pipe, Resource, Task } from "@midnight-ntwrk/faucet-utils";
import { array, either, option } from "fp-ts";
import * as t from "io-ts";
import { DateTime } from "luxon";
import * as crypto from "node:crypto";
import pino from "pino";
import * as rx from "rxjs";
import { taskQueueTimer, taskTimer, taskSuccessCount, taskFailureCount } from "./metrics/index.js";
import { PostgresqlTaskRepository } from "./tasks/task-repository.js";

/**
 * Represents a unique identifier for a task.
 */
export class TaskId {
  /**
   * Creates a TaskId instance from a string.
   * @param id The string representation of the TaskId.
   * @returns A TaskId instance.
   */
  static fromString(id: string): TaskId {
    return new TaskId(id);
  }

  /**
   * Generates a new TaskId.
   * @returns A TaskId instance.
   */
  static generate(): TaskId {
    return new TaskId(crypto.randomUUID());
  }

  /**
   * Creates a new TaskId.
   * @param value The value of the TaskId.
   */
  private constructor(public readonly value: string) {}
}

/**
 * Represents the possible statuses of a task.
 */
export const TaskStatuses = {
  scheduled: "scheduled",
  in_progress: "in_progress",
  success: "success",
  failure: "failure",
} as const;

/**
 * Represents the status of a task.
 */
export type TaskStatus = keyof typeof TaskStatuses;

/**
 * Represents the completed task result
 */
export type CompletedResponse<T> =
  | Readonly<{ status: typeof TaskStatuses.success; value: T }>
  | Readonly<{ status: typeof TaskStatuses.failure; error: string }>;

/**
 * Represents the status of a task.
 */
export type Response<T> =
  | Readonly<{ status: typeof TaskStatuses.scheduled }>
  | Readonly<{ status: typeof TaskStatuses.in_progress }>
  | CompletedResponse<T>;

/**
 * Checks if a response represents a completed task.
 * @param response The response to check.
 * @returns True if the response represents a completed task, false otherwise.
 */
export const isCompleted = <T>(response: Response<T>): boolean => {
  return response.status === TaskStatuses.success || response.status === TaskStatuses.failure;
};

/**
 * Represents a task.
 */
export type ITask = {
  id: string;
  address: string;
  status: TaskStatus;
  state: string;
  start_time: Date;
  end_time: Date;
  created_at: Date;
  updated_at: Date;
  picked_by: string;
  amount: bigint | null;
};

export type UpdateITask = Partial<Omit<ITask, "id" | "created_at" | "updated_at">>;

export type CreateITask = Pick<ITask, "id" | "address"> & { amount?: bigint };

export interface TaskRepository {
  store(task: CreateITask): Promise<ITask>;
  pick(): Promise<ITask | undefined>;
  getById(id: TaskId): Promise<ITask | undefined>;
  getByAddress(address: string): Promise<ITask | undefined>;
  failTimedOutTasks(): Promise<Array<Pick<ITask, "address" | "created_at">>>;
  update(id: TaskId, task: UpdateITask): Promise<ITask>;
  finalizeIfInProgress(id: TaskId, task: UpdateITask): Promise<ITask | undefined>;
  succeedIfFailed(id: TaskId, task: UpdateITask): Promise<ITask | undefined>;
}

/**
 * Configuration options for the TaskManager.
 */
export type TaskManagerConfig = {
  /**
   * The maximum number of tasks to store - only applicable if tasks are kept in memory
   */
  maxStoredResults: number;
  /**
   * The maximum number of tasks that can be run concurrently.
   */
  maxConcurrentTasks: number;
  /**
   * The time in milliseconds between polling for new tasks.
   * */
  pollTime: number;
};

/**
 * Creates a new trace identifier that is compatible with OpenTelemetry.
 *
 * @param task The {@link TaskId} from which to base the trace identifier.
 * @returns A string representing a hex encoded 16 byte value.
 */
const createOpenTelemetryTraceId: (task: string) => string = (task) => task.replaceAll("-", "");

/**
 * The message-bearing fields a thrown value can carry. Decoded as `unknown` so a
 * malformed field never fails the whole decode — each one is re-parsed by
 * {@link formatError} itself.
 */
const ErrorLike = t.partial({
  message: t.unknown,
  reason: t.unknown,
  cause: t.unknown,
  errors: t.unknown,
});

/**
 * Flatten a thrown value and everything nested under it into one readable message.
 *
 * Not restricted to `Error`: the wrappers this unwraps report the underlying node
 * failure inconsistently — a nested `Error`, a bare string, a plain object with a
 * `message`/`reason`, or an `AggregateError`-style `errors` array — and only
 * reporting the outer `.message` hides why a drip failed (#595).
 *
 * `none` when nothing legible can be extracted, so callers pick their own fallback
 * rather than pattern-matching on an empty string. `seen` breaks cyclic references.
 */
const formatError = (
  error: unknown,
  seen: ReadonlySet<unknown> = new Set(),
): option.Option<string> => {
  if (typeof error === "string") {
    return error.length > 0 ? option.some(error) : option.none;
  }
  if (error === null || typeof error !== "object" || seen.has(error)) {
    return option.none;
  }

  const nested = new Set([...seen, error]);
  const fields = pipe(
    ErrorLike.decode(error),
    either.getOrElse((): t.TypeOf<typeof ErrorLike> => ({})),
  );
  const own = pipe(
    formatError(fields.message, nested),
    option.alt(() => formatError(fields.reason, nested)),
  );
  const aggregated = pipe(
    t.array(t.unknown).decode(fields.errors),
    either.getOrElse((): unknown[] => []),
  );
  const causes = [fields.cause, ...aggregated];
  const parts = array.compact([own, ...causes.map((cause) => formatError(cause, nested))]);

  return parts.length > 0 ? option.some(parts.join(": ")) : option.none;
};

/**
 * Decode a persisted task `state` column into `unknown`.
 *
 * Deliberately not typed more tightly: the column carries the task handler's
 * result for a success and a message for a failure, so each caller narrows it
 * for the status it is handling.
 */
const parseTaskState = (state: string | null): unknown => {
  if (state === null || state.length === 0) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(state);
  return parsed;
};

/**
 * How the task lifecycle moves a requester's daily rate-limit slot (#595).
 *
 * Both halves are required together: a manager that consumes slots but cannot
 * refund them is the bug this pair exists to prevent, so it must not be
 * constructible. Passing {@link noRateLimitSlots} is the only way to opt out, and
 * it has to be spelled out at the call site rather than defaulted in.
 */
export type RateLimitSlots = {
  /** Hand back the slot `address` reserved at registration. */
  refund: (address: string, registeredAt: Date) => Promise<void>;
  /** Spend one of `address`'s daily slots, returning the window anchor it landed in. */
  consume: (address: string) => Promise<Date>;
};

/** Slot hooks for callers that don't rate-limit at all, such as unit tests. */
export const noRateLimitSlots: RateLimitSlots = {
  refund: () => Promise.resolve(),
  consume: () => Promise.resolve(new Date()),
};

export class TaskManager<T> {
  taskSubject$: rx.Subject<void>;

  static create<S>(
    logger: pino.Logger,
    config: TaskManagerConfig,
    taskRepository: PostgresqlTaskRepository,
    taskHandler: (address: string, amount?: bigint | string | null) => Promise<S>,
    $canPickTasks: rx.Observable<boolean>,
    slots: RateLimitSlots,
  ): Resource<TaskManager<S>> {
    return pipe(
      Resource.make(
        Task.delay(() => {
          const taskManager = new TaskManager<S>(taskRepository, logger, taskHandler, slots);
          logger.info("Getting to start a task manager");
          taskManager.taskSubject$ = new rx.Subject<void>();
          const interval$ = rx.interval(config.pollTime);
          const taskTriggers$ = rx.merge(taskManager.taskSubject$, interval$);

          const subscription = taskTriggers$
            .pipe(
              // `startWith` matters as much as not filtering: `withLatestFrom` drops
              // every tick until its other source emits, and `$canPickTasks` is built
              // from wallet state, which emits nothing at all if the node is
              // unreachable. Without a seed, a restart during an outage would sweep
              // never — the worst case rather than the edge case (#595).
              rx.withLatestFrom($canPickTasks.pipe(rx.startWith(false))),
              rx.mergeMap(([_, canPickTasks]) => {
                // The sweep runs on every tick, *not* gated on `canPickTasks`: an
                // unsynced or underfunded wallet is precisely when drips strand, so
                // gating the refund behind it would keep every reserved slot burned
                // for the whole outage — the lockout #595 is about. Only `pick` is
                // gated, since only picking needs a usable wallet.
                return rx.from(taskRepository.failTimedOutTasks()).pipe(
                  rx.concatMap(async (timedOut) => {
                    // Timeout/restart failures happen in bulk SQL, outside
                    // executeTask — refund their reserved slots here too (#595).
                    for (const { address, created_at } of timedOut) {
                      await taskManager.refundFailedTask(address, created_at, logger);
                    }
                  }),
                  rx.switchMap(() => (canPickTasks ? rx.from(taskRepository.pick()) : rx.EMPTY)),
                  rx.filter((pickedTask): pickedTask is ITask => pickedTask !== undefined),
                  rx.concatMap(async (pickedTask) => {
                    await taskManager.executeTask(pickedTask);
                    taskManager.taskSubject$.next();
                  }),
                );
              }, config.maxConcurrentTasks),
            )
            .subscribe();

          return { taskManager, subscription };
        }),
        ({ subscription }) =>
          Task.delay(() => {
            subscription.unsubscribe();
          }),
      ),
      Resource.map(({ taskManager }) => taskManager),
    );
  }

  /**
   * Creates a new TaskManager instance.
   * @param taskRepository The task repository.
   * @param logger The logger instance.
   * @param taskHandler The task handler function.
   */
  private constructor(
    private readonly taskRepository: PostgresqlTaskRepository,
    private readonly logger: pino.Logger,
    private readonly taskHandler: (address: string, amount?: bigint | string | null) => Promise<T>,
    private readonly slots: RateLimitSlots,
  ) {
    this.taskSubject$ = new rx.Subject<void>();
  }

  /**
   * Executes a task.
   * @param pickedTask The task to execute.
   * @returns A promise that resolves to the response of the task handler
   */
  private async executeTask(pickedTask: ITask): Promise<Response<T>> {
    const logger = this.logger.child({
      trace_id: createOpenTelemetryTraceId(pickedTask.id),
      id: pickedTask.id,
      scope: "Tasks",
    });

    const startTime = DateTime.now();
    const createdAt = DateTime.fromJSDate(pickedTask.created_at);

    const queueDuration = startTime.diff(createdAt);
    taskQueueTimer.observe(queueDuration.toMillis() / 1000);
    logger.trace("Starting task execution");

    return this.taskHandler(pickedTask.address, pickedTask.amount)
      .then(
        (response): CompletedResponse<T> => {
          logger.debug({ response }, "Scheduled task succeeded");
          return {
            status: TaskStatuses.success,
            value: response,
          };
        },
        (error): CompletedResponse<T> => {
          // Capture the full cause chain: wrappers like the wallet SDK's
          // SubmissionError carry the real reason in `cause`, and reporting only
          // `.message` ("Transaction submission error") hides why a drip failed.
          const reason = pipe(
            formatError(error),
            option.getOrElse(() => "Unknown error"),
          );
          logger.error({ err: error, reason }, `Error in scheduled task`);
          return {
            status: TaskStatuses.failure,
            error: reason,
          };
        },
      )
      .then(async (response) => {
        const endTime = DateTime.now();
        const duration = endTime.diff(startTime);

        taskTimer.observe(duration.toMillis() / 1000);

        // Finalize only while this task is still `in_progress`, so the slot is
        // refunded exactly once no matter which path transitioned the task: a
        // drip that ran past the 5-minute timeout was already failed *and
        // refunded* by the bulk sweep, and `finalizeIfInProgress` then matches
        // no row (#595).
        const finalState: UpdateITask = {
          status: response.status,
          end_time: endTime.toJSDate(),
          state: JSON.stringify(
            response.status === TaskStatuses.success ? response.value : response.error,
          ),
        };
        const finalized = await this.attemptFinalize(pickedTask.id, finalState);

        if (response.status === TaskStatuses.success) {
          if (finalized._tag === "settled") {
            taskSuccessCount.inc();
            logger.info({ duration }, `Task finished in ${duration.toHuman()}`);
            return response;
          }
          // Delivered but not recorded as such — recover the row and the slot.
          await this.settleLateSuccess(pickedTask, finalState, logger);
          return response;
        }

        if (finalized._tag === "settled") {
          taskFailureCount.inc();
          await this.refundFailedTask(pickedTask.address, pickedTask.created_at, logger);
          logger.info({ duration }, `Task finished in ${duration.toHuman()}`);
          return response;
        }

        if (finalized._tag === "alreadySettled") {
          // The sweep already failed *and* refunded this task; refunding again
          // here would hand back a second slot.
          logger.info({ duration }, `Task already finalized after ${duration.toHuman()}`);
          return response;
        }

        // The write threw, so we do not yet know who owns the refund. Retry once:
        // that is the only way to tell "the sweep beat us" from "our UPDATE landed
        // but the driver died", and the latter leaves a `failure` row the sweep will
        // never revisit — a burned slot, which is bug #595 itself.
        const retried = await this.attemptFinalize(pickedTask.id, finalState);

        if (retried._tag === "settled") {
          taskFailureCount.inc();
          await this.refundFailedTask(pickedTask.address, pickedTask.created_at, logger);
          return response;
        }

        if (retried._tag === "alreadySettled") {
          logger.info({ duration }, `Task already finalized after ${duration.toHuman()}`);
          return response;
        }

        // Still unknown. Refunding risks a double refund, so leave it to the sweep
        // and shout, because only an operator can reconcile the row now.
        logger.error(
          { err: retried.err, id: pickedTask.id },
          "Could not determine whether the final task status persisted — slot left to the sweep",
        );
        return response;
      });
  }

  /**
   * Write a task's final status, reporting *which* of three things happened rather
   * than collapsing two of them into one `undefined` (#595):
   *
   * - `settled` — this call moved the row out of `in_progress`, so this call owns
   *   the slot decision.
   * - `alreadySettled` — no `in_progress` row matched, so the sweep got there first
   *   and has already refunded.
   * - `indeterminate` — the write threw, and a driver can fail *after* its UPDATE
   *   commits. Reading that as `alreadySettled` would skip a refund the sweep can no
   *   longer make either, because the row is no longer `in_progress`.
   */
  private async attemptFinalize(
    id: string,
    finalState: UpdateITask,
  ): Promise<
    | { _tag: "settled"; task: ITask }
    | { _tag: "alreadySettled" }
    | { _tag: "indeterminate"; err: unknown }
  > {
    return this.taskRepository
      .finalizeIfInProgress(id, finalState)
      .then((task) =>
        task === undefined
          ? ({ _tag: "alreadySettled" } as const)
          : ({ _tag: "settled", task } as const),
      )
      .catch((err: unknown) => ({ _tag: "indeterminate", err }) as const);
  }

  /**
   * Refund the rate-limit slot a failed drip reserved at registration (#595).
   *
   * **The refund-exactly-once invariant.** Callers must have transitioned the task
   * out of `in_progress` themselves before reaching here — the sweep via its
   * `RETURNING`, {@link executeTask} via {@link PostgresqlTaskRepository.finalizeIfInProgress}.
   * Only one can win, so a slot is refunded once even when both paths finalize a slow
   * drip. Refund errors are logged, never rethrown, so they cannot mask the task.
   */
  private async refundFailedTask(
    address: string,
    registeredAt: Date,
    logger: pino.Logger,
  ): Promise<void> {
    try {
      await this.slots.refund(address, registeredAt);
    } catch (err) {
      logger.error({ err, address }, "Failed to refund rate-limit slot");
    }
  }

  /**
   * Record a drip that delivered tokens but whose finalize did not land, so the
   * task is not `success` in the database. Two ways to get here, distinguished by
   * which row the update matches (#595):
   *
   * - The sweep already failed *and refunded* it. Tokens went out, so the slot must
   *   be spent again rather than left handed back.
   * - The finalize write itself threw and the row is still `in_progress`. The slot
   *   is still correctly spent, so retry the write only. Leaving it would let the
   *   sweep later fail *and refund* a drip that delivered — the caller would keep
   *   both the tokens and the allowance.
   */
  private async settleLateSuccess(
    pickedTask: ITask,
    finalState: UpdateITask,
    logger: pino.Logger,
  ): Promise<void> {
    const reclaimed = await this.taskRepository
      .succeedIfFailed(pickedTask.id, finalState)
      .catch((err: unknown) => {
        logger.error({ err, id: pickedTask.id }, "Failed to reclaim a swept drip success");
        return undefined;
      });

    if (reclaimed !== undefined) {
      taskSuccessCount.inc();
      try {
        await this.slots.consume(pickedTask.address);
      } catch (err) {
        logger.error({ err, address: pickedTask.address }, "Failed to re-consume rate-limit slot");
      }
      logger.warn(
        { id: pickedTask.id, address: pickedTask.address },
        "Drip succeeded after the timeout sweep failed it — reclaimed the refunded rate-limit slot",
      );
      return;
    }

    const retried = await this.taskRepository
      .finalizeIfInProgress(pickedTask.id, finalState)
      .catch((err: unknown) => {
        logger.error({ err, id: pickedTask.id }, "Retry of final task status failed");
        return undefined;
      });

    if (retried === undefined) {
      // Tokens are out and the row is neither `success` nor refundable-by-us. The
      // sweep will eventually fail and refund it, granting a free retry — surface
      // this loudly because only an operator can reconcile it.
      logger.error(
        { id: pickedTask.id, address: pickedTask.address },
        "Drip delivered but could not be recorded as success — slot may be refunded in error",
      );
      return;
    }

    taskSuccessCount.inc();
    logger.warn(
      { id: pickedTask.id, address: pickedTask.address },
      "Recorded a delivered drip whose first finalize failed — rate-limit slot left spent",
    );
  }

  /**
   * Stores an operation to run as a task.
   *
   * @param address The address the task should send tokens to.
   * @param amount Optional amount for the drip (for third-party API).
   * @returns For a given @param address, if an associated task is in-progress, then the identifier of that
   * task; otherwise the identifier of a newly scheduled task.
   */
  async registerTask(address: string, amount?: bigint): Promise<string> {
    const repositoryTask = await this.taskRepository.getByAddress(address);
    if (
      repositoryTask !== undefined &&
      (repositoryTask.status === TaskStatuses.scheduled ||
        repositoryTask.status === TaskStatuses.in_progress)
    ) {
      return repositoryTask.id;
    }

    const taskId = TaskId.generate().value;

    // Reserve on the create path only — the dedup path above must not consume, or a
    // double-submit burns a slot per POST while the one task refunds once. Reserve
    // *before* creating, so a failed reservation leaves no task to dispense; the
    // reverse order would 500 the request and still drip. Separate repositories mean
    // no shared transaction, so a failed create compensates instead (#595).
    const registeredAt = await this.slots.consume(address);

    try {
      await this.taskRepository.create({
        id: taskId,
        address,
        amount,
      });
    } catch (err) {
      await this.refundFailedTask(address, registeredAt, this.logger);
      throw err;
    }

    this.logger.info(`Scheduled task with id ${taskId}${amount ? ` for amount ${amount}` : ""}`);

    return taskId;
  }

  /**
   * Retrieves the status for a task.
   *
   * @param id The task identifier for which the status is required.
   * @returns The {@link Response} of the task identified by `id`.
   */
  async getStatus(id: string): Promise<Response<T>> {
    const task = await this.taskRepository.getById(id);

    if (task !== undefined) {
      const state = parseTaskState(task.state);
      switch (task.status) {
        case TaskStatuses.scheduled:
        case TaskStatuses.in_progress:
          return { status: task.status };
        case TaskStatuses.success:
          return {
            status: task.status,
            // Type cast required because: the column holds whatever the task
            // handler returned, `JSON.stringify`d, and no codec for the generic
            // `T` exists at this layer to decode it back.
            value: state as T,
          };
        case TaskStatuses.failure:
          return {
            status: task.status,
            error: typeof state === "string" ? state : "Task failed",
          };
      }
    }

    return {
      status: TaskStatuses.failure,
      error: `Could not find Task with id ${id}`,
    };
  }
}
