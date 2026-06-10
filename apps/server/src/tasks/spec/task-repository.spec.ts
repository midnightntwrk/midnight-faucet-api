import { Resource, Task } from "@midnight-ntwrk/faucet-utils";
import pino from "pino";
import { vi } from "vitest";
import { PostgresqlTaskRepository, TABLE_NAME } from "../task-repository.js";
import { PostgreInfrastructure, postgresInfrastructure } from "../../testing/postgres.js";

const dbTask = {
  id: "abbd004d-c591-4d83-9612-a64e7dad356e",
  created_at: new Date("2024-07-22T13:09:54.327Z"),
  address:
    "12256023708f94f8f3c4f3ab42e971caf47e0d4f146248a2c3c85fab3383e43a|010000226de51195f2e30c005bf817516d8e311f927510870f0c6839891a74cf68079d",
  state: JSON.stringify({
    transactionIdentifier: "643d823f7e977895e1f834333735dfcff9bd14c1930ed6ca096d18f406f34320",
    timeToNextRequest: "PT0S",
  }),
  status: "success",
};

describe.todo("Task Repository", () => {
  const logger = pino({ level: "silent" });
  let infrastructure: PostgreInfrastructure;
  let teardownInfrastructure: () => Promise<void>;
  let repository: PostgresqlTaskRepository;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    const allocated = await Task.unsafeRun(Resource.allocate(postgresInfrastructure(logger)));
    infrastructure = allocated.value;
    teardownInfrastructure = () => Task.unsafeRun(allocated.teardown);
  });

  afterAll(() => teardownInfrastructure());

  beforeEach(async () => {
    const allocated = await Task.unsafeRun(
      Resource.allocate(
        Resource.fromTask(
          Task.lift(async () => {
            await infrastructure.knex(TABLE_NAME).delete();

            return infrastructure
              .knex(TABLE_NAME)
              .insert(dbTask)
              .then(() => new PostgresqlTaskRepository(infrastructure.knex, "faucet-1", logger));
          }),
        ),
      ),
    );
    repository = allocated.value;
    teardown = () => Task.unsafeRun(allocated.teardown);
  });

  afterEach(() => teardown());

  it("fetches a task from an ID", async () => {
    const task = await repository.getById("abbd004d-c591-4d83-9612-a64e7dad356e");

    expect({ ...task, state: task?.state.toString() }).toEqual(dbTask);
  });

  it("returns nothing if there are no incomplete tasks", async () => {
    const task = await repository.pick();

    expect(task).toBeUndefined();
  });

  it("returns the oldest incomplete tasks if available", async () => {
    await infrastructure.knex("transaction_snapshots").insert({
      id: "7036ef33-a146-4699-87a5-54e25d3c9d1b",
      address: dbTask.address,
      status: "in_progress",
      state: "",
    });

    await infrastructure.knex("transaction_snapshots").insert({
      id: "fa609b02-1b66-44a6-a331-6d3d6b5a7fee",
      address: dbTask.address,
      status: "scheduled",
      state: "",
    });

    const task = await repository.pick();

    expect(task?.id).toBe("7036ef33-a146-4699-87a5-54e25d3c9d1b");
  });

  it("updates tasks by ID", async () => {
    await infrastructure.knex("transaction_snapshots").insert({
      id: "7036ef33-a146-4699-87a5-54e25d3c9d1b",
      created_at: new Date("2024-07-22T13:09:54.327Z"),
      address: dbTask.address,
      status: "scheduled",
      state: "",
    });

    const task = await repository.update("7036ef33-a146-4699-87a5-54e25d3c9d1b", {
      address: dbTask.address,
      status: "success",
      state: JSON.stringify({
        transactionIdentifier: "643d823f7e977895e1f834333735dfcff9bd14c1930ed6ca096d18f406f34320",
        timeToNextRequest: "PT0S",
      }),
    });

    expect(task?.id).toBe("7036ef33-a146-4699-87a5-54e25d3c9d1b");

    const updatedTask = await repository.getById("7036ef33-a146-4699-87a5-54e25d3c9d1b");

    expect(updatedTask?.status).toBe("success");
    expect(updatedTask?.state.length).toBeGreaterThan(0);
  });

  it("creates tasks", async () => {
    const task = await repository.create({
      id: dbTask.id,
      address: dbTask.address,
    });

    expect(task).toBeDefined();
  });

  it("creates tasks with default empty state", async () => {
    const task = await repository.create({
      address: dbTask.address,
      id: "xxxxxxxxxxxxxxxxxxx",
    });

    expect(task).toBeDefined();
  });

  it("should log errors when database requests fail", async () => {
    await teardownInfrastructure();
    const spyOnLogger = vi.spyOn(logger, "error");
    await repository.getById("abbd004d-c591-4d83-9612-a64e7dad356e");

    expect(spyOnLogger).toHaveBeenCalledTimes(1);

    await repository.pick();

    expect(spyOnLogger).toHaveBeenCalledTimes(2);

    await repository.update("7036ef33-a146-4699-87a5-54e25d3c9d1b", {
      address: dbTask.address,
      status: "success",
      state: JSON.stringify({
        transactionIdentifier: "643d823f7e977895e1f834333735dfcff9bd14c1930ed6ca096d18f406f34320",
        timeToNextRequest: "PT0S",
      }),
    });

    expect(spyOnLogger).toHaveBeenCalledTimes(3);

    await repository.create({
      id: dbTask.id,
      address: dbTask.address,
    });

    expect(spyOnLogger).toHaveBeenCalledTimes(4);
  });
});
