import { Resource, Task } from "@midnight-ntwrk/faucet-utils";
import pino from "pino";
import { PostgreInfrastructure, postgresInfrastructure } from "../../testing/postgres.js";
import { saveState } from "../serialize-and-save-state.js";
import { PostgresqlStateSnapshotsRepository } from "../state-persistence-repository.js";
import { type PostgresqlTaskRepository } from "../../tasks/task-repository.js";
import { type PostgresqlRateCountRepository } from "../../rate-counts/rate-counts-repository.js";

describe("serialize and save state", () => {
  const logger = pino({ level: "silent" });
  let infrastructure: PostgreInfrastructure;
  let teardownInfrastructure: () => Promise<void>;
  let repository: PostgresqlStateSnapshotsRepository;
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
          Task.lift(() =>
            infrastructure
              .knex("state_snapshots")
              .delete()
              // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
              .then(() => new PostgresqlStateSnapshotsRepository(infrastructure.knex, "faucet-1")),
          ),
        ),
      ),
    );
    repository = allocated.value;
    teardown = () => Task.unsafeRun(allocated.teardown);
  });

  afterEach(() => teardown());

  it("should store the serialized state as plaintext", async () => {
    const inserted = await saveState({
      shieldedState: "shielded-state",
      unshieldedState: "unshielded-state",
      dustState: "dust-state",
      stateContext: {
        stateSnapshots: repository,
        taskRepository: {} as PostgresqlTaskRepository,
        rateCountRepository: {} as PostgresqlRateCountRepository,
      },
      logger,
    });

    expect(inserted).toBeDefined();
    expect(await repository.getState(logger)).toMatchObject({
      shielded: "shielded-state",
      unshielded: "unshielded-state",
      dust: "dust-state",
    });
  });

  it("should return undefined when it cannot save to the database", async () => {
    await teardownInfrastructure();
    const state = await saveState({
      shieldedState: "",
      unshieldedState: "",
      dustState: "",
      stateContext: {
        stateSnapshots: repository,
        taskRepository: {} as PostgresqlTaskRepository,
        rateCountRepository: {} as PostgresqlRateCountRepository,
      },
      logger,
    });

    expect(state).toBeUndefined();
  });
});
