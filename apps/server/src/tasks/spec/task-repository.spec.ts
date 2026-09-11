import { Resource, Task } from "@midnightntwrk/faucet-utils";
import * as nodeCrypto from "node:crypto";
import pino from "pino";
import { PostgreInfrastructure, postgresInfrastructure } from "../../testing/postgres.js";
import { PostgresqlTaskRepository, StatusType, TABLE_NAME } from "../task-repository.js";
import {
  IN_PROGRESS_TIMEOUT_MINUTES,
  QUEUE_STALLED_MINUTES,
  SCHEDULED_TIMEOUT_MINUTES,
} from "../task-timeouts.js";

/**
 * The status-guarded writes in this repository are what make the rate-limit slot
 * lifecycle single-winner: exactly one of the timeout sweep and the task's own
 * finalize may transition a row, and therefore exactly one of them refunds the
 * slot. `TaskManager` cannot prove that on its own — it only sees `undefined` — so
 * the guarantee is pinned here, against real Postgres.
 */

const TIMED_OUT_MESSAGE = "Token request failed due to timeout";

describe("Task Repository", () => {
  const logger = pino({ level: "silent" });

  // Test setup and teardown are the accepted exception to the const-only rule:
  // the container outlives every test and can only be handed over by assignment.
  let infrastructure: PostgreInfrastructure;
  let teardown: Task<void>;

  beforeAll(async () => {
    const allocated = await Task.unsafeRun(Resource.allocate(postgresInfrastructure(logger)));
    infrastructure = allocated.value;
    teardown = allocated.teardown;
  });

  afterAll(async () => {
    await Task.unsafeRun(teardown);
  });

  // `pick` and `failTimedOutTasks` select across the whole table, so every test
  // starts from an empty one rather than scoping its assertions by address.
  beforeEach(async () => {
    await infrastructure.knex(TABLE_NAME).delete();
  });

  const repository = (identifier = "faucet-test") =>
    new PostgresqlTaskRepository(infrastructure.knex, identifier, logger);

  const createAddress = () => nodeCrypto.randomBytes(32).toString("hex");

  /**
   * Insert a task directly, bypassing `create`, so a test can start from a status
   * and age the repository's own API cannot produce — an `in_progress` row
   * orphaned by a restart, for instance.
   */
  const insertTask = async ({
    address,
    status,
    startedMinutesAgo = 0,
    createdMinutesAgo = startedMinutesAgo ?? 0,
    state = "",
  }: {
    address: string;
    status: StatusType;
    // `null` writes a NULL `start_time`, which the column permits but neither
    // `create` nor `pick` produces — the case the sweep's `coalesce` guards.
    startedMinutesAgo?: number | null;
    createdMinutesAgo?: number;
    state?: string;
  }): Promise<string> => {
    const id = nodeCrypto.randomUUID();
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

    await infrastructure.knex(TABLE_NAME).insert({
      id,
      address,
      status,
      state,
      picked_by: status === "scheduled" ? null : "faucet-test",
      start_time: startedMinutesAgo === null ? null : minutesAgo(startedMinutesAgo),
      created_at: minutesAgo(createdMinutesAgo),
      // Aged with the row, so a test can tell a sweep's write apart from the
      // column default.
      end_time: minutesAgo(createdMinutesAgo),
    });

    return id;
  };

  const endTimeOf = async (id: string): Promise<Date | undefined> =>
    repository()
      .getById(id)
      .then((task) => task?.end_time);

  const statusOf = async (id: string): Promise<string | undefined> =>
    repository()
      .getById(id)
      .then((task) => task?.status);

  const stateOf = async (id: string): Promise<string | undefined> =>
    repository()
      .getById(id)
      .then((task) => task?.state.toString());

  const stranded = () => IN_PROGRESS_TIMEOUT_MINUTES + 5;

  describe("finalizeIfInProgress", () => {
    it("transitions a task that is still in progress", async () => {
      const id = await insertTask({ address: createAddress(), status: "in_progress" });

      const finalized = await repository().finalizeIfInProgress(id, {
        status: "failure",
        state: JSON.stringify("insufficient funds"),
      });

      expect(finalized?.id).toBe(id);
      expect(await statusOf(id)).toBe("failure");
    });

    it("matches nothing on a second call, so a slot is refunded once", async () => {
      const id = await insertTask({ address: createAddress(), status: "in_progress" });
      await repository().finalizeIfInProgress(id, {
        status: "failure",
        state: JSON.stringify("first"),
      });

      const second = await repository().finalizeIfInProgress(id, {
        status: "failure",
        state: JSON.stringify("second"),
      });

      expect(second).toBeUndefined();
      // The losing call must not write either: the row belongs to the winner.
      expect(await stateOf(id)).toBe(JSON.stringify("first"));
    });

    it("matches nothing once the sweep has already failed the task", async () => {
      const id = await insertTask({
        address: createAddress(),
        status: "failure",
        state: JSON.stringify(TIMED_OUT_MESSAGE),
      });

      const finalized = await repository().finalizeIfInProgress(id, {
        status: "failure",
        state: JSON.stringify("dispense rejected"),
      });

      expect(finalized).toBeUndefined();
      expect(await stateOf(id)).toBe(JSON.stringify(TIMED_OUT_MESSAGE));
    });

    it("matches nothing for a task that was never picked", async () => {
      const id = await insertTask({ address: createAddress(), status: "scheduled" });

      expect(
        await repository().finalizeIfInProgress(id, { status: "success", state: "{}" }),
      ).toBeUndefined();
      expect(await statusOf(id)).toBe("scheduled");
    });
  });

  describe("succeedIfFailed", () => {
    it("reclaims a task the sweep marked as failed", async () => {
      const id = await insertTask({
        address: createAddress(),
        status: "failure",
        state: JSON.stringify(TIMED_OUT_MESSAGE),
      });

      const reclaimed = await repository().succeedIfFailed(id, {
        status: "success",
        state: JSON.stringify({ transactionIdentifier: "tx-1" }),
      });

      expect(reclaimed?.id).toBe(id);
      expect(await statusOf(id)).toBe("success");
    });

    it("matches nothing on a second call, so a slot is re-consumed once", async () => {
      const id = await insertTask({ address: createAddress(), status: "failure" });
      await repository().succeedIfFailed(id, { status: "success", state: JSON.stringify("tx-1") });

      const second = await repository().succeedIfFailed(id, {
        status: "success",
        state: JSON.stringify("tx-2"),
      });

      expect(second).toBeUndefined();
      expect(await stateOf(id)).toBe(JSON.stringify("tx-1"));
    });

    it("refuses a task that is still in progress", async () => {
      // Only the sweep's `failure` row may be reclaimed. A live task must be
      // finalized through `finalizeIfInProgress`, which is what decides whether
      // the slot stays spent.
      const id = await insertTask({ address: createAddress(), status: "in_progress" });

      expect(
        await repository().succeedIfFailed(id, { status: "success", state: "{}" }),
      ).toBeUndefined();
      expect(await statusOf(id)).toBe("in_progress");
    });
  });

  describe("failTimedOutTasks", () => {
    it("fails and reports every task it strands, not just the first", async () => {
      const first = createAddress();
      const second = createAddress();
      const firstId = await insertTask({
        address: first,
        status: "in_progress",
        startedMinutesAgo: stranded(),
      });
      const secondId = await insertTask({
        address: second,
        status: "in_progress",
        startedMinutesAgo: stranded(),
      });

      const swept = await repository().failTimedOutTasks();

      expect(swept.map(({ address }) => address).sort()).toEqual([first, second].sort());
      // The caller refunds against `created_at`, so the sweep has to report the
      // registration time rather than the time it gave up.
      swept.forEach(({ created_at }) => expect(created_at).toBeInstanceOf(Date));
      expect(await statusOf(firstId)).toBe("failure");
      expect(await statusOf(secondId)).toBe("failure");
      expect(await stateOf(firstId)).toBe(JSON.stringify(TIMED_OUT_MESSAGE));
    });

    it("reports a stranded task to one sweep only", async () => {
      await insertTask({
        address: createAddress(),
        status: "in_progress",
        startedMinutesAgo: stranded(),
      });

      expect(await repository().failTimedOutTasks()).toHaveLength(1);
      // A second refund would decrement a slot the requester spent on a later,
      // healthy request.
      expect(await repository().failTimedOutTasks()).toEqual([]);
    });

    it("concurrent sweeps strand a task exactly once between them", async () => {
      // Two server instances poll the same table. The refund follows whichever
      // `RETURNING` reports the row, so the row may appear in one result only.
      await insertTask({
        address: createAddress(),
        status: "in_progress",
        startedMinutesAgo: stranded(),
      });

      const sweeps = await Promise.all([
        repository("faucet-1").failTimedOutTasks(),
        repository("faucet-2").failTimedOutTasks(),
      ]);

      expect(sweeps.flat()).toHaveLength(1);
    });

    it("fails an in-progress task that never had a start_time", async () => {
      // The column permits NULL and `NULL < timestamp` is NULL, so without the
      // `coalesce` fallback such a row is invisible to every future sweep — stuck in
      // a status nothing else clears.
      const id = await insertTask({
        address: createAddress(),
        status: "in_progress",
        startedMinutesAgo: null,
        createdMinutesAgo: stranded(),
      });

      expect(await repository().failTimedOutTasks()).toHaveLength(1);
      expect(await statusOf(id)).toBe("failure");
    });

    it("stamps end_time when it gives up on a task", async () => {
      const id = await insertTask({
        address: createAddress(),
        status: "in_progress",
        startedMinutesAgo: stranded(),
      });
      const before = await endTimeOf(id);

      await repository().failTimedOutTasks();

      const after = await endTimeOf(id);
      expect(after?.getTime()).toBeGreaterThan(before!.getTime());
    });

    it("leaves a task that has not yet timed out", async () => {
      const id = await insertTask({
        address: createAddress(),
        status: "in_progress",
        startedMinutesAgo: IN_PROGRESS_TIMEOUT_MINUTES - 1,
      });

      expect(await repository().failTimedOutTasks()).toEqual([]);
      expect(await statusOf(id)).toBe("in_progress");
    });

    it("fails a scheduled task nothing drained within its window", async () => {
      // This used to be left alone however old it got, on the grounds that `pick`
      // selects on `scheduled` so a healthy instance would still run it. That bounds
      // the wait only while some instance *is* able to pick: with none, the row never
      // advances, and since migration 009 it is also what stops its address
      // requesting again — so the requester was pinned on a task that would never run
      // (#622).
      const id = await insertTask({
        address: createAddress(),
        status: "scheduled",
        createdMinutesAgo: SCHEDULED_TIMEOUT_MINUTES + 5,
      });

      expect(await repository().failTimedOutTasks()).toHaveLength(1);
      expect(await statusOf(id)).toBe("failure");
      expect(await stateOf(id)).toBe(JSON.stringify(TIMED_OUT_MESSAGE));
    });

    it("leaves an over-age scheduled task queued while the poller is still picking", async () => {
      // `pick` is oldest-first and runs one drip at a time, so under a burst the rows
      // past the age threshold are exactly the ones about to be served. Age alone
      // cannot tell that from a queue nothing is draining — recent pick activity can.
      const id = await insertTask({
        address: createAddress(),
        status: "scheduled",
        createdMinutesAgo: SCHEDULED_TIMEOUT_MINUTES + 5,
      });
      // A drip picked and completed a moment ago: the poller is plainly alive.
      await insertTask({
        address: createAddress(),
        status: "success",
        startedMinutesAgo: QUEUE_STALLED_MINUTES - 1,
      });

      expect(await repository().failTimedOutTasks()).toEqual([]);
      expect(await statusOf(id)).toBe("scheduled");
    });

    it("leaves a scheduled task inside its window queued", async () => {
      // The other half of the same contract, and the reason the window is an hour
      // rather than the in-progress five minutes: a queued task is only stale if
      // nothing is draining the queue, not merely because it is waiting its turn.
      // Sweeping it sooner would refund a slot for a drip about to be dispensed.
      const id = await insertTask({
        address: createAddress(),
        status: "scheduled",
        createdMinutesAgo: SCHEDULED_TIMEOUT_MINUTES - 1,
      });

      expect(await repository().failTimedOutTasks()).toEqual([]);
      expect(await statusOf(id)).toBe("scheduled");
    });
  });

  describe("pick", () => {
    it("returns nothing when no task is scheduled", async () => {
      await insertTask({ address: createAddress(), status: "in_progress" });

      expect(await repository().pick()).toBeUndefined();
    });

    it("takes the oldest scheduled task and marks it in progress", async () => {
      const older = createAddress();
      const olderId = await insertTask({
        address: older,
        status: "scheduled",
        createdMinutesAgo: 10,
      });
      await insertTask({ address: createAddress(), status: "scheduled", createdMinutesAgo: 1 });

      const picked = await repository("faucet-worker").pick();

      expect(picked?.id).toBe(olderId);
      const stored = await repository().getById(olderId);
      expect(stored?.status).toBe("in_progress");
      expect(stored?.picked_by).toBe("faucet-worker");
    });

    it("hands a task to one worker only", async () => {
      // `forUpdate().skipLocked()` is what stops two instances dispensing the same
      // drip — and, with it, spending one slot on two transactions.
      await insertTask({ address: createAddress(), status: "scheduled" });

      const picks = await Promise.all([
        repository("faucet-1").pick(),
        repository("faucet-2").pick(),
      ]);

      expect(picks.filter((task) => task !== undefined)).toHaveLength(1);
    });
  });

  describe("create", () => {
    it("schedules a task with no amount", async () => {
      const address = createAddress();

      const created = await repository().create({ id: nodeCrypto.randomUUID(), address });

      expect(created.status).toBe("scheduled");
      expect(created.address).toBe(address);
      expect(created.amount).toBeNull();
    });

    it("keeps the requested amount", async () => {
      const created = await repository().create({
        id: nodeCrypto.randomUUID(),
        address: createAddress(),
        amount: 1_000n,
      });

      expect(BigInt(created.amount ?? 0n)).toBe(1_000n);
    });
  });

  describe("getById", () => {
    it("returns nothing for an unknown task", async () => {
      expect(await repository().getById(nodeCrypto.randomUUID())).toBeUndefined();
    });
  });

  describe("getByAddress", () => {
    it("finds the live task for an address requesting for the first time", async () => {
      const address = createAddress();
      const liveId = await insertTask({ address, status: "scheduled" });

      const found = await repository().getByAddress(address);

      expect({ id: found?.id, status: found?.status }).toEqual({ id: liveId, status: "scheduled" });
    });

    /**
     * Regression for #617, fixed in #619. The filter used to exclude the settled
     * statuses as `andWhereNot("status", ["failure", "succeeded"])`, which knex
     * compiles to a comparison against the literal `'{"failure","succeeded"}'` — a
     * value no status ever equals, so the predicate held for every row and a settled
     * task came back as though it were active. (`"succeeded"` was not a status
     * either; the value is `success`.) Selecting `ACTIVE_STATUSES` positively is
     * what closed it.
     */
    it.each(["success", "failure"] as const)(
      "ignores an address whose only task %s",
      async (status) => {
        const address = createAddress();
        await insertTask({ address, status });

        expect(await repository().getByAddress(address)).toBeUndefined();
      },
    );

    /**
     * The pairing #617 was reported for. `registerTask` reads this row to decide
     * whether a request duplicates one in flight, so handing it an old settled task
     * is what let a duplicate reserve a second daily slot.
     */
    it("finds the active task for an address that has already been served", async () => {
      const address = createAddress();
      await insertTask({ address, status: "success", createdMinutesAgo: 120 });
      await insertTask({ address, status: "failure", createdMinutesAgo: 60 });
      const activeId = await insertTask({ address, status: "in_progress" });

      const found = await repository().getByAddress(address);

      expect({ id: found?.id, status: found?.status }).toEqual({
        id: activeId,
        status: "in_progress",
      });
    });

    it("ignores tasks belonging to other addresses", async () => {
      await insertTask({ address: createAddress(), status: "scheduled" });

      expect(await repository().getByAddress(createAddress())).toBeUndefined();
    });
  });
});
