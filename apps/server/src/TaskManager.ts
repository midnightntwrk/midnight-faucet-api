/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { pipe, Resource, Task } from "@midnight-ntwrk/faucet-utils";
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
  failTimedOutTasks(): Promise<void>;
  update(id: TaskId, task: UpdateITask): Promise<ITask>;
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

export class TaskManager<T> {
  taskSubject$: rx.Subject<void>;

  static create<S>(
    logger: pino.Logger,
    config: TaskManagerConfig,
    taskRepository: PostgresqlTaskRepository,
    taskHandler: (address: string, amount?: bigint | string | null) => Promise<S>,
    $canPickTasks: rx.Observable<boolean>,
  ): Resource<TaskManager<S>> {
    return pipe(
      Resource.make(
        Task.delay(() => {
          const taskManager = new TaskManager<S>(taskRepository, logger, taskHandler);
          logger.info("Getting to start a task manager");
          taskManager.taskSubject$ = new rx.Subject<void>();
          const interval$ = rx.interval(config.pollTime);
          const taskTriggers$ = rx.merge(taskManager.taskSubject$, interval$);

          const subscription = taskTriggers$
            .pipe(
              rx.withLatestFrom($canPickTasks),
              rx.filter(([_, canPickTasks]) => canPickTasks),
              rx.mergeMap(() => {
                return rx.from(taskRepository.failTimedOutTasks()).pipe(
                  rx.switchMap(() =>
                    rx.from(taskRepository.pick()).pipe(
                      rx.filter((pickedTask): pickedTask is ITask => pickedTask !== undefined),
                      rx.concatMap(async (pickedTask) => {
                        await taskManager.executeTask(pickedTask);
                        taskManager.taskSubject$.next();
                      }),
                    ),
                  ),
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
          logger.error({ err: error }, `Error in scheduled task`);
          return {
            status: TaskStatuses.failure,
            error: error.message,
          };
        },
      )
      .then(async (response) => {
        const endTime = DateTime.now();
        const duration = endTime.diff(startTime);

        taskTimer.observe(duration.toMillis() / 1000);

        if (response.status === TaskStatuses.success) {
          taskSuccessCount.inc();
        } else {
          taskFailureCount.inc();
        }

        try {
          await this.taskRepository.update(pickedTask.id, {
            status: response.status,
            end_time: endTime.toJSDate(),
            state: JSON.stringify(
              response.status === TaskStatuses.success ? response.value : response.error,
            ),
          });
        } catch (err) {
          logger.error(
            { err, id: pickedTask.id, finalStatus: response.status },
            "Failed to persist final task status — task may appear stuck",
          );
        }
        logger.info({ duration }, `Task finished in ${duration.toHuman()}`);
        return response;
      });
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

    await this.taskRepository.create({
      id: taskId,
      address,
      amount,
    });

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
      switch (task.status) {
        case TaskStatuses.scheduled:
        case TaskStatuses.in_progress:
          return { status: task.status };
        case TaskStatuses.success:
          return {
            status: task.status,
            value: task.state ? JSON.parse(task.state) : undefined,
          };
        case TaskStatuses.failure:
          return {
            status: task.status,
            error: task.state ? JSON.parse(task.state) : "Task failed",
          };
      }
    }

    return {
      status: TaskStatuses.failure,
      error: `Could not find Task with id ${id}`,
    };
  }
}
