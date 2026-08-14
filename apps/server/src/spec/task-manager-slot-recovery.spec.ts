import { pipe, Resource, Task } from "@midnight-ntwrk/faucet-utils";
import pino from "pino";
import * as rx from "rxjs";
import { vi } from "vitest";
import { RateLimitSlots, TaskManager, TaskManagerConfig } from "../TaskManager.js";
import { PostgresqlTaskRepository, TaskType } from "../tasks/task-repository.js";

/**
 * Unit coverage for the rate-limit slot lifecycle (#595) at the points where the
 * database writes that own the refund-exactly-once invariant *fail*.
 *
 * `apps/server/src/spec/server.spec.ts` already exercises the happy paths and the
 * sweep/executeTask race against real Postgres. What it cannot reach is a failing
 * `finalizeIfInProgress` or `succeedIfFailed`, and those branches decide whether a
 * requester who received tokens also keeps their daily allowance — so they are
 * driven here through a fake repository instead.
 */

const ADDRESS = "mn_addr_undeployed1qpfkp8dd8xpv57t3sf0p5cex8a37qz40kjlz7hke3aq6mfk2pkyshz6pq0";
const TASK_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const REGISTERED_AT = new Date("2026-07-31T11:59:00.000Z");

const config: TaskManagerConfig = {
  maxStoredResults: 5,
  maxConcurrentTasks: 3,
  // Long enough that the interval never fires during a test: every tick is driven
  // explicitly via `taskSubject$`, so the assertions do not race the poller.
  pollTime: 60_000,
};

const taskRow = (overrides: Partial<TaskType> = {}): TaskType => ({
  id: TASK_ID,
  address: ADDRESS,
  state: "",
  status: "in_progress",
  picked_by: "faucet-test",
  start_time: new Date("2026-07-31T12:00:00.000Z"),
  end_time: new Date("2026-07-31T12:00:00.000Z"),
  created_at: REGISTERED_AT,
  updated_at: new Date("2026-07-31T12:00:00.000Z"),
  amount: null,
  ...overrides,
});

/**
 * A pino logger that keeps its output, so branches whose only observable effect is
 * an operator-facing log can still be asserted on.
 */
const collectingLogger = () => {
  // Mutation is confined to test capture: pino hands us lines one at a time.
  const lines: string[] = [];
  const logger = pino(
    { level: "trace" },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );

  return { logger, logged: (message: string) => lines.some((line) => line.includes(message)) };
};

const fakeRepository = () => ({
  failTimedOutTasks: vi.fn((): Promise<Array<Pick<TaskType, "address" | "created_at">>> =>
    Promise.resolve([]),
  ),
  pick: vi.fn((): Promise<TaskType | undefined> => Promise.resolve(undefined)),
  getById: vi.fn((_id: string): Promise<TaskType | undefined> => Promise.resolve(undefined)),
  getByAddress: vi.fn((_address: string): Promise<TaskType | undefined> =>
    Promise.resolve(undefined),
  ),
  create: vi.fn((_task: { address: string; id: string; amount?: bigint }): Promise<TaskType> =>
    Promise.resolve(taskRow({ status: "scheduled" })),
  ),
  finalizeIfInProgress: vi.fn(
    (_id: string, _task: Partial<TaskType>): Promise<TaskType | undefined> =>
      Promise.resolve(taskRow()),
  ),
  succeedIfFailed: vi.fn((_id: string, _task: Partial<TaskType>): Promise<TaskType | undefined> =>
    Promise.resolve(undefined),
  ),
});

type FakeRepository = ReturnType<typeof fakeRepository>;

/**
 * `TaskManager` depends on the concrete `PostgresqlTaskRepository`, whose private
 * `knex`/`Tasks` members a fake cannot structurally satisfy.
 *
 * Type cast required because: the class has no interface to implement against —
 * `TaskRepository` in `TaskManager.ts` describes a different, `TaskId`-keyed shape —
 * so the only seam for a fake is the cast the existing specs also use.
 */
const asRepository = (fake: FakeRepository): PostgresqlTaskRepository =>
  fake as unknown as PostgresqlTaskRepository;

/**
 * `consume` resolves a distinct anchor rather than `new Date()`, so a test can prove
 * a compensating refund was given the anchor the reservation actually wrote instead
 * of an app-clock guess (#595).
 */
const RESERVED_ANCHOR = new Date("2026-07-31T12:00:00.000Z");

const fakeSlots = () => ({
  refund: vi.fn((_address: string, _registeredAt: Date): Promise<void> => Promise.resolve()),
  consume: vi.fn((_address: string): Promise<Date> => Promise.resolve(RESERVED_ANCHOR)),
});

type Harness<T> = {
  repository: FakeRepository;
  slots: RateLimitSlots & ReturnType<typeof fakeSlots>;
  manager: TaskManager<T>;
  logged: (message: string) => boolean;
  /** Run one poll tick and wait for the assertion it should satisfy to hold. */
  tick: (assertion: () => void) => Promise<void>;
};

const withManager = <T>(
  setup: {
    repository: FakeRepository;
    slots: ReturnType<typeof fakeSlots>;
    handler: (address: string) => Promise<T>;
    /**
     * Defaults to an observable that is already `true`. Pass one that never emits to
     * model a wallet that cannot reach the node — `withLatestFrom` drops every tick
     * until its other source emits, so `rx.of`/`BehaviorSubject` cannot reach that
     * case at all (#595).
     */
    canPickTasks?: rx.Observable<boolean>;
  },
  body: (harness: Harness<T>) => Promise<void>,
): Promise<void> => {
  const { logger, logged } = collectingLogger();

  return pipe(
    TaskManager.create<T>(
      logger,
      config,
      asRepository(setup.repository),
      setup.handler,
      setup.canPickTasks ?? rx.of(true),
      setup.slots,
    ),
    Resource.use((manager) =>
      Task.lift(() =>
        body({
          repository: setup.repository,
          slots: setup.slots,
          manager,
          logged,
          tick: async (assertion) => {
            manager.taskSubject$.next();
            await vi.waitFor(assertion);
          },
        }),
      ),
    ),
    Task.unsafeRun,
  );
};

/** A picked task the poller hands to `executeTask` exactly once. */
const picksOnce = (repository: FakeRepository, task: TaskType = taskRow()): void => {
  repository.pick.mockResolvedValueOnce(task).mockResolvedValue(undefined);
};

describe("TaskManager rate-limit slot recovery", () => {
  describe("a drip that delivered but could not be finalized", () => {
    it("re-consumes the slot the sweep refunded when the success is reclaimed", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      picksOnce(repository);
      // No `in_progress` row left: the timeout sweep already failed and refunded it.
      repository.finalizeIfInProgress.mockResolvedValue(undefined);
      repository.succeedIfFailed.mockResolvedValue(taskRow({ status: "success" }));

      await withManager({ repository, slots, handler: () => Promise.resolve("tx-1") }, (harness) =>
        harness.tick(() => {
          expect(slots.consume).toHaveBeenCalledWith(ADDRESS);
          expect(slots.refund).not.toHaveBeenCalled();
        }),
      );
    });

    it("keeps the reclaimed success when re-consuming the slot fails", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      picksOnce(repository);
      repository.finalizeIfInProgress.mockResolvedValue(undefined);
      repository.succeedIfFailed.mockResolvedValue(taskRow({ status: "success" }));
      slots.consume.mockRejectedValue(new Error("rate count table unavailable"));

      await withManager({ repository, slots, handler: () => Promise.resolve("tx-1") }, (harness) =>
        harness.tick(() => {
          expect(harness.logged("Failed to re-consume rate-limit slot")).toBe(true);
          // The reclaim itself must stand — the row is `success`, so the sweep will
          // not come back and refund a drip that delivered.
          expect(repository.succeedIfFailed).toHaveBeenCalledTimes(1);
        }),
      );
    });

    it("retries the finalize when the write threw and the task is still in progress", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      picksOnce(repository);
      repository.finalizeIfInProgress
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValue(taskRow({ status: "success" }));
      // Nothing to reclaim: the row never reached `failure`, so the sweep did not run.
      repository.succeedIfFailed.mockResolvedValue(undefined);

      await withManager({ repository, slots, handler: () => Promise.resolve("tx-1") }, (harness) =>
        harness.tick(() => {
          expect(repository.finalizeIfInProgress).toHaveBeenCalledTimes(2);
          expect(harness.logged("Recorded a delivered drip whose first finalize failed")).toBe(
            true,
          );
          // The slot was spent at registration and the drip delivered, so it stays
          // spent: neither a refund nor a second consume is correct here.
          expect(slots.refund).not.toHaveBeenCalled();
          expect(slots.consume).not.toHaveBeenCalled();
        }),
      );
    });

    it("falls through to the retry when the reclaim write itself throws", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      picksOnce(repository);
      repository.finalizeIfInProgress
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValue(taskRow({ status: "success" }));
      repository.succeedIfFailed.mockRejectedValue(new Error("deadlock detected"));

      await withManager({ repository, slots, handler: () => Promise.resolve("tx-1") }, (harness) =>
        harness.tick(() => {
          expect(harness.logged("Failed to reclaim a swept drip success")).toBe(true);
          expect(repository.finalizeIfInProgress).toHaveBeenCalledTimes(2);
          expect(slots.refund).not.toHaveBeenCalled();
        }),
      );
    });

    it("alerts the operator when neither write records the delivered drip", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      picksOnce(repository);
      repository.finalizeIfInProgress.mockRejectedValue(new Error("connection reset"));
      repository.succeedIfFailed.mockResolvedValue(undefined);

      await withManager({ repository, slots, handler: () => Promise.resolve("tx-1") }, (harness) =>
        harness.tick(() => {
          expect(harness.logged("Drip delivered but could not be recorded as success")).toBe(true);
          // Only an operator can reconcile this, so the manager must not guess:
          // refunding would hand back an allowance for tokens that went out.
          expect(slots.refund).not.toHaveBeenCalled();
          expect(slots.consume).not.toHaveBeenCalled();
        }),
      );
    });
  });

  describe("a drip that failed", () => {
    it("refunds the slot it reserved", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      picksOnce(repository);
      repository.finalizeIfInProgress.mockResolvedValue(taskRow({ status: "failure" }));

      await withManager(
        { repository, slots, handler: () => Promise.reject(new Error("insufficient funds")) },
        (harness) =>
          harness.tick(() => {
            expect(slots.refund).toHaveBeenCalledExactlyOnceWith(ADDRESS, REGISTERED_AT);
          }),
      );
    });

    it("does not refund again when the sweep already refunded it", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      picksOnce(repository);
      // The sweep won the transition, and refunded as part of it.
      repository.finalizeIfInProgress.mockResolvedValue(undefined);

      await withManager(
        { repository, slots, handler: () => Promise.reject(new Error("insufficient funds")) },
        (harness) =>
          harness.tick(() => {
            expect(harness.logged("Task already finalized")).toBe(true);
            expect(slots.refund).not.toHaveBeenCalled();
          }),
      );
    });

    it("does not let a failing refund mask the task result", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      picksOnce(repository);
      repository.finalizeIfInProgress.mockResolvedValue(taskRow({ status: "failure" }));
      slots.refund.mockRejectedValue(new Error("rate count table unavailable"));
      repository.getById.mockResolvedValue(
        taskRow({ status: "failure", state: JSON.stringify("insufficient funds") }),
      );

      await withManager(
        { repository, slots, handler: () => Promise.reject(new Error("insufficient funds")) },
        async (harness) => {
          await harness.tick(() => {
            expect(harness.logged("Failed to refund rate-limit slot")).toBe(true);
          });

          expect(await harness.manager.getStatus(TASK_ID)).toEqual({
            status: "failure",
            error: "insufficient funds",
          });
        },
      );
    });

    // A throw and a no-row-matched must not look the same. A driver can fail *after*
    // the UPDATE commits, and treating that as "the sweep already refunded" would
    // skip a refund the sweep can no longer make either — the row is no longer
    // `in_progress`. Retrying is what tells the two apart (#595).
    it("retries the finalize before deciding the sweep already refunded", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      picksOnce(repository);
      // First write throws; the retry shows the row was still ours to transition.
      repository.finalizeIfInProgress
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValue(taskRow({ status: "failure" }));

      await withManager(
        { repository, slots, handler: () => Promise.reject(new Error("insufficient funds")) },
        (harness) =>
          harness.tick(() => {
            expect(repository.finalizeIfInProgress).toHaveBeenCalledTimes(2);
            expect(slots.refund).toHaveBeenCalledExactlyOnceWith(ADDRESS, REGISTERED_AT);
          }),
      );
    });

    it("stops once the retry shows the sweep got there first", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      picksOnce(repository);
      // The write threw, and the retry finds no in-progress row: the sweep won
      // after all, and has already handed the slot back.
      repository.finalizeIfInProgress
        .mockRejectedValueOnce(new Error("connection reset"))
        .mockResolvedValue(undefined);

      await withManager(
        { repository, slots, handler: () => Promise.reject(new Error("insufficient funds")) },
        (harness) =>
          harness.tick(() => {
            expect(harness.logged("Task already finalized")).toBe(true);
            expect(repository.finalizeIfInProgress).toHaveBeenCalledTimes(2);
            expect(slots.refund).not.toHaveBeenCalled();
          }),
      );
    });

    it("leaves the slot to the sweep when the finalize outcome stays unknown", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      picksOnce(repository);
      repository.finalizeIfInProgress.mockRejectedValue(new Error("connection reset"));

      await withManager(
        { repository, slots, handler: () => Promise.reject(new Error("insufficient funds")) },
        (harness) =>
          harness.tick(() => {
            expect(harness.logged("Could not determine whether the final task status")).toBe(true);
            // Refunding here could double-refund; the sweep is the safe owner.
            expect(slots.refund).not.toHaveBeenCalled();
          }),
      );
    });
  });

  /**
   * What a failed drip reports back to the requester. The wrappers around a
   * dispense report the underlying node failure inconsistently — nested causes, an
   * aggregate of attempts, a bare string — and reporting only the outermost
   * `message` leaves "Transaction submission error" as the whole explanation.
   *
   * Driven through a failing task because the flattening is internal to the
   * manager; the persisted `state` is where its result becomes observable.
   */
  describe("the message a failed drip records", () => {
    const persistedFailure = async (error: unknown): Promise<string | undefined> => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      picksOnce(repository);
      repository.finalizeIfInProgress.mockResolvedValue(taskRow({ status: "failure" }));

      await withManager(
        {
          repository,
          slots,
          // Rejecting with something that is not an `Error` is the subject of these
          // cases, not an oversight: the wallet SDK throws bare strings and plain
          // objects, and flattening those is what this describe covers.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          handler: () => Promise.reject(error),
        },
        (harness) =>
          harness.tick(() => {
            expect(repository.finalizeIfInProgress).toHaveBeenCalled();
          }),
      );

      return repository.finalizeIfInProgress.mock.calls[0]?.[1].state;
    };

    it("keeps the whole cause chain, not just the outermost wrapper", async () => {
      const error = new Error("Transaction submission error", {
        cause: new Error("node rejected: insufficient balance"),
      });

      expect(await persistedFailure(error)).toBe(
        JSON.stringify("Transaction submission error: node rejected: insufficient balance"),
      );
    });

    it("reports every attempt an aggregate failure carries", async () => {
      const error = new AggregateError(
        [new Error("proof server timed out"), new Error("node unreachable")],
        "all submissions failed",
      );

      expect(await persistedFailure(error)).toBe(
        JSON.stringify("all submissions failed: proof server timed out: node unreachable"),
      );
    });

    it("reads a thrown string", async () => {
      expect(await persistedFailure("node rejected the transaction")).toBe(
        JSON.stringify("node rejected the transaction"),
      );
    });

    it("falls back to a reason when there is no message", async () => {
      expect(await persistedFailure({ reason: "wallet is not synced" })).toBe(
        JSON.stringify("wallet is not synced"),
      );
    });

    it("terminates on a cause that points back at itself", async () => {
      // Mutation is the only way to build a cycle, and a cycle is exactly what the
      // wrappers produce when a retry attaches its own attempt as the cause.
      const cyclic: { message: string; cause?: unknown } = { message: "submission failed" };
      cyclic.cause = cyclic;

      expect(await persistedFailure(cyclic)).toBe(JSON.stringify("submission failed"));
    });

    it("says something even when the failure carries nothing legible", async () => {
      expect(await persistedFailure({})).toBe(JSON.stringify("Unknown error"));
      expect(await persistedFailure(new Error(""))).toBe(JSON.stringify("Unknown error"));
    });
  });

  describe("the timeout sweep", () => {
    it("refunds every task it strands, not just the first", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      const otherAddress = `${ADDRESS}-other`;
      const otherCreatedAt = new Date("2026-07-31T11:58:00.000Z");
      repository.failTimedOutTasks
        .mockResolvedValueOnce([
          { address: ADDRESS, created_at: REGISTERED_AT },
          { address: otherAddress, created_at: otherCreatedAt },
        ])
        .mockResolvedValue([]);

      await withManager({ repository, slots, handler: () => Promise.resolve("tx-1") }, (harness) =>
        harness.tick(() => {
          expect(slots.refund).toHaveBeenCalledTimes(2);
          expect(slots.refund).toHaveBeenCalledWith(ADDRESS, REGISTERED_AT);
          expect(slots.refund).toHaveBeenCalledWith(otherAddress, otherCreatedAt);
        }),
      );
    });

    it("refunds the rest of a batch when one refund fails", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      const addresses = [ADDRESS, `${ADDRESS}-second`, `${ADDRESS}-third`];
      repository.failTimedOutTasks
        .mockResolvedValueOnce(addresses.map((address) => ({ address, created_at: REGISTERED_AT })))
        .mockResolvedValue([]);
      // One address's refund fails. The sweep has already failed all three rows,
      // so abandoning the batch here would burn the remaining slots for good.
      slots.refund.mockRejectedValueOnce(new Error("rate count table unavailable"));

      await withManager({ repository, slots, handler: () => Promise.resolve("tx-1") }, (harness) =>
        harness.tick(() => {
          expect(slots.refund).toHaveBeenCalledTimes(addresses.length);
          expect(harness.logged("Failed to refund rate-limit slot")).toBe(true);
        }),
      );
    });

    // The wallet-state observable emits nothing until the wallet reaches the node, so
    // a restart during an outage leaves `$canPickTasks` silent — not `false`. Without
    // a seeded value `withLatestFrom` would drop every tick and the sweep would never
    // run, which is the #595 lockout at its worst rather than its edge (#595).
    it("still refunds when the wallet state never emits at all", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      repository.failTimedOutTasks
        .mockResolvedValueOnce([{ address: ADDRESS, created_at: REGISTERED_AT }])
        .mockResolvedValue([]);

      await withManager(
        {
          repository,
          slots,
          handler: () => Promise.resolve("tx-1"),
          canPickTasks: new rx.Subject<boolean>(),
        },
        (harness) =>
          harness.tick(() => {
            expect(slots.refund).toHaveBeenCalledExactlyOnceWith(ADDRESS, REGISTERED_AT);
          }),
      );
    });

    it("does not pick tasks while the wallet state never emits", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      repository.pick.mockResolvedValue(taskRow({ status: "in_progress" }));

      await withManager(
        {
          repository,
          slots,
          handler: () => Promise.resolve("tx-1"),
          canPickTasks: new rx.Subject<boolean>(),
        },
        async (harness) => {
          await harness.tick(() => {
            expect(repository.failTimedOutTasks).toHaveBeenCalled();
          });
          expect(repository.pick).not.toHaveBeenCalled();
        },
      );
    });
  });

  describe("registerTask", () => {
    it("refunds the slot it reserved when the task row cannot be created", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      const failure = new Error("unique violation");
      repository.create.mockRejectedValue(failure);

      await withManager(
        { repository, slots, handler: () => Promise.resolve("tx-1") },
        async (harness) => {
          await expect(harness.manager.registerTask(ADDRESS)).rejects.toThrow(failure);

          expect(slots.consume).toHaveBeenCalledExactlyOnceWith(ADDRESS);
          // Compensate the reservation: there is no task left to fail and refund it.
          // The anchor must be the one the reservation returned — refunding against
          // an app-clock date silently no-ops whenever the clocks straddle midnight.
          expect(slots.refund).toHaveBeenCalledExactlyOnceWith(ADDRESS, RESERVED_ANCHOR);
        },
      );
    });

    it("does not reserve a second slot for a request deduped onto a live task", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      repository.getByAddress.mockResolvedValue(taskRow({ status: "in_progress" }));

      await withManager(
        { repository, slots, handler: () => Promise.resolve("tx-1") },
        async (harness) => {
          expect(await harness.manager.registerTask(ADDRESS)).toBe(TASK_ID);

          expect(slots.consume).not.toHaveBeenCalled();
          expect(repository.create).not.toHaveBeenCalled();
        },
      );
    });

    it("dedupes onto a task that is queued but not yet picked", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      // A wallet that cannot pick leaves tasks `scheduled` for as long as the
      // outage lasts, which is when a requester is most likely to resubmit.
      repository.getByAddress.mockResolvedValue(taskRow({ status: "scheduled" }));

      await withManager(
        { repository, slots, handler: () => Promise.resolve("tx-1") },
        async (harness) => {
          expect(await harness.manager.registerTask(ADDRESS)).toBe(TASK_ID);

          expect(slots.consume).not.toHaveBeenCalled();
        },
      );
    });

    it("reserves a slot for a request following a settled task", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      // Nothing is in flight, so this is a new drip and must cost a slot —
      // otherwise a requester's second request of the day would be free.
      repository.getByAddress.mockResolvedValue(taskRow({ status: "success" }));

      await withManager(
        { repository, slots, handler: () => Promise.resolve("tx-1") },
        async (harness) => {
          expect(await harness.manager.registerTask(ADDRESS)).not.toBe(TASK_ID);

          expect(slots.consume).toHaveBeenCalledExactlyOnceWith(ADDRESS);
          expect(repository.create).toHaveBeenCalledTimes(1);
        },
      );
    });

    it("schedules nothing when the reservation itself fails", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      const failure = new Error("rate count table unavailable");
      slots.consume.mockRejectedValue(failure);

      await withManager(
        { repository, slots, handler: () => Promise.resolve("tx-1") },
        async (harness) => {
          await expect(harness.manager.registerTask(ADDRESS)).rejects.toThrow(failure);

          // Reserving before creating is what keeps this safe: with no task there
          // is nothing to dispense, and nothing was reserved to hand back.
          expect(repository.create).not.toHaveBeenCalled();
          expect(slots.refund).not.toHaveBeenCalled();
        },
      );
    });
  });

  describe("getStatus", () => {
    it("reports a generic failure when the stored state is not a message", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      repository.getById.mockResolvedValue(
        taskRow({ status: "failure", state: JSON.stringify({ code: 500 }) }),
      );

      await withManager(
        { repository, slots, handler: () => Promise.resolve("tx-1") },
        async (harness) => {
          expect(await harness.manager.getStatus(TASK_ID)).toEqual({
            status: "failure",
            error: "Task failed",
          });
        },
      );
    });

    it("reports a failure for a task it cannot find", async () => {
      const repository = fakeRepository();
      const slots = fakeSlots();
      repository.getById.mockResolvedValue(undefined);

      await withManager(
        { repository, slots, handler: () => Promise.resolve("tx-1") },
        async (harness) => {
          expect(await harness.manager.getStatus(TASK_ID)).toEqual({
            status: "failure",
            error: `Could not find Task with id ${TASK_ID}`,
          });
        },
      );
    });
  });
});
