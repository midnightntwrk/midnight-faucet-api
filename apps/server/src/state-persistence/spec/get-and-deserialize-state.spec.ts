/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Resource, Task } from "@midnight-ntwrk/faucet-utils";
import pino from "pino";
import { vi } from "vitest";
import { PostgreInfrastructure, postgresInfrastructure } from "../../testing/postgres.js";
import { PostgresqlStateSnapshotsRepository } from "../state-persistence-repository.js";
import { getState } from "../get-and-deserialize-state.js";

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
              .insert({
                shielded:
                  "mn_shield-addr_undeployed1ultslmhufn32879kzanlsvmxvt493tk83y82hrwchggy5r93gpex5uajcx78sucyaghmgshlcn8c4xedxxgr4lejkjh5ztz0m47uk5q9uacjt",
                unshielded:
                  "mn_addr_undeployed1qpfkp8dd8xpv57t3sf0p5cex8a37qz40kjlz7hke3aq6mfk2pkyshz6pq0",
                dust: "mn_dust_undeployed1wvggp4jmr2ynq3xf5rzgshjqyxjmdg9sp8hke22tp8d8g5vrawnryf5gld6",
                identifier: "faucet-1",
              })
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
    const faucetState = await getState({
      logger,
      stateRepository: repository,
      encryptionKey,
    });
    expect(faucetState).toEqual({
      address:
        "2f7f9d626334e7f1d0ceea95565287f4256dad50599b929bbddc670fba70831c|0100008d9cf18b7b72d28aa7a35583f48ae3abec78db48fe87737e56318bd43eef80bf",
      availableBalance: 25000000000000000n,
      availableCoins: [
        5000000000000000n,
        5000000000000000n,
        5000000000000000n,
        5000000000000000n,
        5000000000000000n,
      ],
      syncProgress: {
        synced: 9n,
        total: 9n,
      },
      totalBalance: 25000000000000000n,
      totalCoins: [
        5000000000000000n,
        5000000000000000n,
        5000000000000000n,
        5000000000000000n,
        5000000000000000n,
      ],
    });
  });

  it("should return undefined when it can't find any state", async () => {
    await infrastructure.knex("state_snapshots").delete();

    const faucetState = await getState({
      logger,
      stateRepository: repository,
      encryptionKey,
    });

    expect(faucetState).toBeUndefined();
  });

  it("should throw when the stored data cannot be decrypted", async () => {
    await infrastructure.knex("state_snapshots").delete().insert({
      shielded:
        "mn_shield-addr_undeployed1ultslmhufn32879kzanlsvmxvt493tk83y82hrwchggy5r93gpex5uajcx78sucyaghmgshlcn8c4xedxxgr4lejkjh5ztz0m47uk5q9uacjt",
      unshielded: "mn_addr_undeployed1qpfkp8dd8xpv57t3sf0p5cex8a37qz40kjlz7hke3aq6mfk2pkyshz6pq0",
      dust: "mn_dust_undeployed1wvggp4jmr2ynq3xf5rzgshjqyxjmdg9sp8hke22tp8d8g5vrawnryf5gld6",
      identifier: "faucet-1",
    });

    await expect(
      getState({
        logger,
        stateRepository: repository,
        encryptionKey,
      }),
    ).rejects.toThrow();
  });

  it("should return undefined when it can't find any state after teardown", async () => {
    await teardownInfrastructure();
    const spyOnLogger = vi.spyOn(logger, "error");

    const faucetState = await getState({
      logger,
      stateRepository: repository,
      encryptionKey,
    });

    expect(faucetState).toBeUndefined();
    expect(spyOnLogger).toHaveBeenCalled();
  });
});
