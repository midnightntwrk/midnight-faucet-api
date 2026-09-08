import { vi } from "vitest";
import { TaskId } from "../../TaskManager.js";
import {
  IN_PROGRESS_TIMEOUT_MINUTES,
  QUEUE_STALLED_MINUTES,
  SCHEDULED_TIMEOUT_MINUTES,
} from "../../tasks/task-timeouts.js";
import { InMemoryTaskRepository } from "../task-repository.js";

/**
 * The in-memory repository is the fake the `TaskManager` unit tests run against, so
 * it has to agree with `PostgresqlTaskRepository` about dedup and timeouts. When it
 * did not, a test written against it reproduced #622 and passed: `getByAddress`
 * matched on address alone, exactly as the broken SQL predicate effectively did.
 */
describe("InMemoryTaskRepository", () => {
  const ADDRESS = "mn_addr_undeployed1qpfkp8dd8xpv57t3sf0p5cex8a37qz40kjlz7hke3aq6mfk2pkyshz6pq0";
  const OTHER_ADDRESS =
    "mn_addr_undeployed1qqxq0y0eqk4x0k3pfvz5g8g4jw7pk2z6zzq5cxqfj6r7z7dq0q9qsl0v6zq";
  const NOW = new Date("2026-08-21T12:00:00.000Z");

  const repository = () => new InMemoryTaskRepository(10);

  /** Store a task as though it had been created `minutesAgo`, then return to `NOW`. */
  const storeAged = async (
    repo: InMemoryTaskRepository,
    { id, address, minutesAgo }: { id: string; address: string; minutesAgo: number },
  ) => {
    vi.setSystemTime(new Date(NOW.getTime() - minutesAgo * 60 * 1000));
    const task = await repo.store({ id, address });
    vi.setSystemTime(NOW);
    return task;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getByAddress", () => {
    it("ignores tasks that already finished", async () => {
      const repo = repository();
      const finished = await storeAged(repo, { id: "task-1", address: ADDRESS, minutesAgo: 10 });
      await repo.update(TaskId.fromString(finished.id), { status: "success" });
      await storeAged(repo, { id: "task-2", address: ADDRESS, minutesAgo: 1 });

      // Insertion order would hand back the finished task and shadow the live one.
      expect(await repo.getByAddress(ADDRESS)).toMatchObject({ id: "task-2" });
    });

    it("returns nothing when every task for the address has finished", async () => {
      const repo = repository();
      const finished = await storeAged(repo, { id: "task-1", address: ADDRESS, minutesAgo: 10 });
      await repo.update(TaskId.fromString(finished.id), { status: "failure" });

      expect(await repo.getByAddress(ADDRESS)).toBeUndefined();
    });

    it("returns the oldest active task, matching what pick would run first", async () => {
      const repo = repository();
      await storeAged(repo, { id: "newer", address: ADDRESS, minutesAgo: 1 });
      await storeAged(repo, { id: "older", address: ADDRESS, minutesAgo: 30 });

      expect(await repo.getByAddress(ADDRESS)).toMatchObject({ id: "older" });
    });

    it("does not match another address's task", async () => {
      const repo = repository();
      await storeAged(repo, { id: "task-1", address: OTHER_ADDRESS, minutesAgo: 1 });

      expect(await repo.getByAddress(ADDRESS)).toBeUndefined();
    });
  });

  describe("pick", () => {
    it("takes the oldest scheduled task and marks it in progress", async () => {
      const repo = repository();
      await storeAged(repo, { id: "newer", address: OTHER_ADDRESS, minutesAgo: 1 });
      await storeAged(repo, { id: "older", address: ADDRESS, minutesAgo: 30 });

      const picked = await repo.pick();

      expect(picked).toMatchObject({ id: "older", status: "in_progress" });
    });

    it("claims the task, so a second pick does not hand out the same one", async () => {
      const repo = repository();
      await storeAged(repo, { id: "only", address: ADDRESS, minutesAgo: 1 });

      await repo.pick();

      expect(await repo.pick()).toBeUndefined();
    });

    // The divergence this closes: a picked task left `scheduled` would, once it aged
    // past the scheduled window, be failed by the fake's own sweep while the manager
    // was still executing it.
    it("does not leave a picked task exposed to the scheduled sweep", async () => {
      const repo = repository();
      await storeAged(repo, {
        id: "running",
        address: ADDRESS,
        minutesAgo: SCHEDULED_TIMEOUT_MINUTES + 1,
      });

      await repo.pick();

      expect(await repo.failTimedOutTasks()).toEqual([]);
    });
  });

  describe("failTimedOutTasks", () => {
    it("fails a scheduled task nothing ever picked up", async () => {
      const repo = repository();
      await storeAged(repo, {
        id: "stranded",
        address: ADDRESS,
        minutesAgo: SCHEDULED_TIMEOUT_MINUTES + 1,
      });

      const timedOut = await repo.failTimedOutTasks();
      expect(timedOut.map(({ address }) => address)).toEqual([ADDRESS]);
      // The refund is only half of it: the address has to stop being pinned.
      expect(await repo.getByAddress(ADDRESS)).toBeUndefined();
    });

    it("leaves an over-age scheduled task alone while the poller is still picking", async () => {
      const repo = repository();
      await storeAged(repo, {
        id: "queued",
        address: ADDRESS,
        minutesAgo: SCHEDULED_TIMEOUT_MINUTES + 1,
      });
      // Something else was picked a moment ago, so the queue is busy, not stalled.
      await storeAged(repo, {
        id: "running",
        address: OTHER_ADDRESS,
        minutesAgo: QUEUE_STALLED_MINUTES - 1,
      });
      await repo.pick();

      expect(await repo.failTimedOutTasks()).toEqual([]);
    });

    it("leaves a scheduled task inside its window queued", async () => {
      const repo = repository();
      await storeAged(repo, {
        id: "queued",
        address: ADDRESS,
        minutesAgo: SCHEDULED_TIMEOUT_MINUTES - 1,
      });

      expect(await repo.failTimedOutTasks()).toEqual([]);
      expect(await repo.getByAddress(ADDRESS)).toMatchObject({ id: "queued" });
    });

    it("fails an in-progress task past the shorter in-progress window", async () => {
      const repo = repository();
      const task = await storeAged(repo, {
        id: "orphaned",
        address: ADDRESS,
        minutesAgo: IN_PROGRESS_TIMEOUT_MINUTES + 1,
      });
      // `update` cannot backdate `created_at`, so age the row first and only then
      // move it to in_progress, keeping `start_time` where `storeAged` left it.
      await repo.update(TaskId.fromString(task.id), {
        status: "in_progress",
        start_time: task.start_time,
      });

      const timedOut = await repo.failTimedOutTasks();
      expect(timedOut.map(({ address }) => address)).toEqual([ADDRESS]);
    });

    it("leaves an in-progress task inside its window alone, despite an older created_at", async () => {
      const repo = repository();
      const task = await storeAged(repo, {
        id: "running",
        address: ADDRESS,
        minutesAgo: SCHEDULED_TIMEOUT_MINUTES + 1,
      });
      // Picked just now: the scheduled window must not apply once it is running.
      await repo.update(TaskId.fromString(task.id), { status: "in_progress", start_time: NOW });

      expect(await repo.failTimedOutTasks()).toEqual([]);
    });
  });
});
