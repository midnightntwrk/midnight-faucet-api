import crypto from "node:crypto";
import { Resource, Task } from "@midnight-ntwrk/faucet-utils";
import pino from "pino";
import { PostgreInfrastructure, postgresInfrastructure } from "../../testing/postgres.js";
import { saveState } from "../serialize-and-save-state.js";
import { PostgresqlStateSnapshotsRepository } from "../state-persistence-repository.js";
import { type PostgresqlTaskRepository } from "../../tasks/task-repository.js";
import { type PostgresqlRateCountRepository } from "../../rate-counts/rate-counts-repository.js";

const encryptionKey = Buffer.from(
  "ae18ad906ec2686f7cd8e3b9e97255f4d048225771c0412e82717256dc27c49a",
  "hex",
);

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

  it.todo("should return state after saving it", async () => {
    const id = await saveState({
      encryptionKey,

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

    expect(id).toBeDefined();
  });

  it("should throw when encryption key is invalid", () => {
    expect(() =>
      saveState({
        encryptionKey: crypto.randomBytes(22),
        shieldedState: "",
        unshieldedState: "",
        dustState: "",
        stateContext: {
          stateSnapshots: repository,
          taskRepository: {} as PostgresqlTaskRepository,
          rateCountRepository: {} as PostgresqlRateCountRepository,
        },
        logger,
      }),
    ).toThrow();
  });

  it("should return undefined when it cannot save to the database", async () => {
    await teardownInfrastructure();
    const state = await saveState({
      encryptionKey,
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
