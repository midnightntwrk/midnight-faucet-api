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
  failTimedOutTasks: vi.fn(
    (): Promise<Array<Pick<TaskType, "address" | "created_at">>> => Promise.resolve([]),
  ),
  pick: vi.fn((): Promise<TaskType | undefined> => Promise.resolve(undefined)),
  getById: vi.fn((_id: string): Promise<TaskType | undefined> => Promise.resolve(undefined)),
  getByAddress: vi.fn(
    (_address: string): Promise<TaskType | undefined> => Promise.resolve(undefined),
  ),
  create: vi.fn(
    (_task: { address: string; id: string; amount?: bigint }): Promise<TaskType> =>
      Promise.resolve(taskRow({ status: "scheduled" })),
  ),
  finalizeIfInProgress: vi.fn(
    (_id: string, _task: Partial<TaskType>): Promise<TaskType | undefined> =>
      Promise.resolve(taskRow()),
  ),
  succeedIfFailed: vi.fn(
    (_id: string, _task: Partial<TaskType>): Promise<TaskType | undefined> =>
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

const fakeSlots = () => ({
  refund: vi.fn((_address: string, _registeredAt: Date): Promise<void> => Promise.resolve()),
  consume: vi.fn((_address: string): Promise<void> => Promise.resolve()),
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
      rx.of(true),
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
          expect(slots.refund).toHaveBeenCalledTimes(1);
          expect(slots.refund.mock.calls[0][0]).toBe(ADDRESS);
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
  });
});
