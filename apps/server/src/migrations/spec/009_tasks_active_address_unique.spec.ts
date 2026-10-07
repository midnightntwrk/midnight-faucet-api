import { Resource, Task } from "@midnightntwrk/faucet-utils";
import * as nodeCrypto from "node:crypto";
import pino from "pino";
import { migrationConfig } from "../../postgres.js";
import { StatusType, TABLE_NAME } from "../../tasks/task-repository.js";
import { PostgreInfrastructure, postgresInfrastructure } from "../../testing/postgres.js";

/**
 * Migration 009 is the only part of the one-active-task-per-address change that
 * runs against data that already exists. The dedup predicate it replaces matched
 * nothing, so production tables hold addresses with several active rows, and `up`
 * has to settle those before the unique index can be created at all. Every other
 * suite migrates an empty database, which never exercises that cleanup.
 */

const MIGRATION = "009_tasks_active_address_unique.js";
const INDEX_NAME = "tasks_active_address_unique";
const SUPERSEDED_STATE = JSON.stringify("Superseded by an earlier request for the same address");
const UNIQUE_VIOLATION = "23505";

describe("Migration 009: one active task per address", () => {
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

  // Each test starts with 009 rolled back, so it can seed the duplicates the index
  // would otherwise refuse, and then applies it itself.
  beforeEach(async () => {
    await infrastructure.knex.migrate.down({ ...migrationConfig, name: MIGRATION });
  });

  afterEach(async () => {
    await infrastructure.knex(TABLE_NAME).delete();
    await infrastructure.knex.migrate.latest(migrationConfig);
  });

  const migrateUp = () => infrastructure.knex.migrate.up({ ...migrationConfig, name: MIGRATION });

  const createAddress = () => nodeCrypto.randomBytes(32).toString("hex");

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  const insertTask = async ({
    address,
    status,
    createdMinutesAgo,
    state = "",
  }: {
    address: string;
    status: StatusType;
    createdMinutesAgo: number;
    state?: string;
  }): Promise<string> => {
    const id = nodeCrypto.randomUUID();
    await infrastructure.knex(TABLE_NAME).insert({
      id,
      address,
      status,
      state,
      picked_by: status === "scheduled" ? null : "faucet-test",
      start_time: minutesAgo(createdMinutesAgo),
      created_at: minutesAgo(createdMinutesAgo),
      end_time: minutesAgo(createdMinutesAgo),
      amount: null,
    });
    return id;
  };

  const rowOf = (id: string) =>
    infrastructure
      .knex<{ id: string; status: string; state: Buffer; end_time: Date }>(TABLE_NAME)
      .where({ id })
      .first()
      .then((row) => ({
        status: row?.status,
        // `state` is a bytea column, so it reads back as a Buffer.
        state: row?.state.toString(),
        endTime: row?.end_time,
      }));

  const indexExists = () =>
    infrastructure
      .knex("pg_indexes")
      .where({ tablename: TABLE_NAME, indexname: INDEX_NAME })
      .first()
      .then((row) => row !== undefined);

  it("keeps the oldest active task per address and fails the rest", async () => {
    const twoScheduled = createAddress();
    const oldestScheduled = await insertTask({
      address: twoScheduled,
      status: "scheduled",
      createdMinutesAgo: 90,
    });
    const newerScheduled = await insertTask({
      address: twoScheduled,
      status: "scheduled",
      createdMinutesAgo: 30,
    });

    // The oldest row survives whatever its status, so a running drip outranks a
    // newer queued one rather than the other way round.
    const runningAndQueued = createAddress();
    const running = await insertTask({
      address: runningAndQueued,
      status: "in_progress",
      createdMinutesAgo: 60,
    });
    const queuedBehind = await insertTask({
      address: runningAndQueued,
      status: "scheduled",
      createdMinutesAgo: 10,
    });

    const single = createAddress();
    const onlyActive = await insertTask({
      address: single,
      status: "scheduled",
      createdMinutesAgo: 5,
    });

    await migrateUp();

    expect(await rowOf(oldestScheduled)).toMatchObject({ status: "scheduled" });
    expect(await rowOf(running)).toMatchObject({ status: "in_progress" });
    expect(await rowOf(onlyActive)).toMatchObject({ status: "scheduled" });

    const superseded = await Promise.all([rowOf(newerScheduled), rowOf(queuedBehind)]);
    superseded.forEach((row) => {
      expect(row).toMatchObject({ status: "failure", state: SUPERSEDED_STATE });
      // Stamped by the migration, not left at the seeded age.
      expect(row.endTime!.getTime()).toBeGreaterThan(minutesAgo(1).getTime());
    });
  });

  it("leaves finished history alone", async () => {
    // A repeat requester: finished drips from earlier, one live request now. The
    // finished rows were never duplicates of anything and must not be rewritten.
    const address = createAddress();
    const succeeded = await insertTask({
      address,
      status: "success",
      createdMinutesAgo: 120,
      state: JSON.stringify({ transactionIdentifier: "abc" }),
    });
    const failed = await insertTask({
      address,
      status: "failure",
      createdMinutesAgo: 60,
      state: JSON.stringify("Token request failed due to timeout"),
    });
    const live = await insertTask({ address, status: "scheduled", createdMinutesAgo: 5 });
    const before = await Promise.all([rowOf(succeeded), rowOf(failed)]);

    await migrateUp();

    expect(await Promise.all([rowOf(succeeded), rowOf(failed)])).toEqual(before);
    expect(await rowOf(live)).toMatchObject({ status: "scheduled" });
  });

  it("enforces one active task per address once applied", async () => {
    const address = createAddress();
    await insertTask({ address, status: "scheduled", createdMinutesAgo: 5 });

    await migrateUp();

    expect(await indexExists()).toBe(true);
    await expect(
      insertTask({ address, status: "in_progress", createdMinutesAgo: 1 }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    // The index is partial: finished rows sit outside it, however many there are.
    await expect(
      insertTask({ address, status: "success", createdMinutesAgo: 1 }),
    ).resolves.toBeTypeOf("string");
  });
});
