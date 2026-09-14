/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Faucet } from "@midnightntwrk/faucet-internal-api";
import { block, firstL, pipe, Resource, Task } from "@midnightntwrk/faucet-utils";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import { randomBytes } from "crypto";
import { either } from "fp-ts";
import path from "path";
import pino from "pino";
import pinoPretty from "pino-pretty";
import {
  debounceTime,
  delay,
  distinctUntilChanged,
  filter,
  map,
  firstValueFrom,
  BehaviorSubject,
} from "rxjs";
import { DockerComposeEnvironment, StartedDockerComposeEnvironment, Wait } from "testcontainers";
import {
  FaucetConfig,
  FaucetImpl,
  getWalletAddress,
  calculateFaucetState,
  InsufficientFundsError,
  getFaucetState,
} from "../FaucetImpl.js";
import { doCheck, StandardWalletConfig, WalletFactory, WalletURLs } from "../WalletFactory.js";
import { unshieldedToken } from "@midnightntwrk/ledger-v9";

type Environment = {
  urls: WalletURLs;
  seed: Buffer;
  networkId: NetworkId.NetworkId;
  genesisBalance: bigint;
  composeEnvironment: StartedDockerComposeEnvironment;
};

const environment = (): Resource<Environment> => {
  return pipe(
    Resource.make(
      Task.lift(() => {
        // The indexer is gated from the host rather than by a compose healthcheck: its image
        // ships no curl or wget, so any in-container HTTP probe exits 127 forever and the
        // container is eventually marked unhealthy. /ready returns 200 once the node is
        // producing blocks and the indexer's storage has migrated.
        // withStartupTimeout must stay below vitest's hookTimeout.
        const env = new DockerComposeEnvironment(path.resolve("."), "test-compose.yml")
          .withStartupTimeout(240_000)
          .withWaitStrategy("faucet-test-indexer", Wait.forHttp("/ready", 8088));
        return env.up();
      }),
      (env) =>
        Task.lift(async () => {
          await env.down({ timeout: 60_000 });
        }),
    ),
    Resource.map((runningEnvironment) => {
      const nodeURL = new URL(
        `ws://localhost:${runningEnvironment.getContainer("faucet-test-node").getMappedPort(9944)}`,
      );
      const indexerURL = new URL(
        `http://localhost:${runningEnvironment
          .getContainer("faucet-test-indexer")
          .getMappedPort(8088)}/api/v4/graphql`,
      );
      const indexerSubscriptionURL = block(() => {
        const out = new URL(indexerURL);
        out.protocol = "ws";
        out.pathname = `${out.pathname}/ws`;
        return out;
      });
      const provingServerURL = new URL(
        `http://localhost:${runningEnvironment
          .getContainer("faucet-test-proof-server")
          .getMappedPort(6300)}`,
      );
      return {
        urls: {
          indexerURL,
          indexerSubscriptionURL,
          nodeURL,
          provingServerURL,
        },
        seed: Buffer.from(
          "0000000000000000000000000000000000000000000000000000000000000001",
          "hex",
        ),
        networkId: NetworkId.NetworkId.Undeployed,
        genesisBalance: 25_000_000_000_000_00n,
        composeEnvironment: runningEnvironment,
      };
    }),
  );
};

// TODO: make those tests more parallel and less sequential, to save time spent on testing
describe("Faucet transacting & connectivity", () => {
  let env: Environment;
  beforeAll(async () => {
    const allocated = await Task.unsafeRun(Resource.allocate(environment()));
    env = allocated.value;
  });

  const TX_PROCESSING_DELAY = 900000;

  it.todo(
    "creates and submits transaction that sends tokens to provided address",
    async () => {
      const logger = pino(
        {
          level: "trace",
        },
        pinoPretty({ colorize: true }),
      );

      const faucetConfig: FaucetConfig<StandardWalletConfig> = {
        networkId: NetworkId.NetworkId.Undeployed,
        dropAmount: "1000", // 1000 tNight
        targetCoinNumber: 1,
        targetCoinSizeFactor: 10n,
        walletConfig: {
          urls: env.urls,
          logLevel: "debug",
          networkId: NetworkId.NetworkId.Undeployed,
        },
        walletSeed: env.seed,
        numberOfOutputs: 1,
      };
      const walletFactory = WalletFactory(faucetConfig.walletConfig, logger);
      const faucetResource: Resource<Faucet> = FaucetImpl(faucetConfig, {
        walletFactory,
        logger,
      });

      const receiverWalletRes = walletFactory.fromSeed(randomBytes(32));
      return pipe(
        faucetResource,
        Resource.mapPromise((faucet) =>
          // We need to wait a bit before running second wallet
          firstValueFrom(
            faucet.state$.pipe(
              filter((state) => state.unshielded.availableBalance > 0n),
              delay(1000),
              map(() => faucet),
            ),
          ),
        ),
        Resource.zip(receiverWalletRes),
        Resource.use(([faucet, receiverWallet]) => {
          const faucetBalanceT = pipe(
            faucet.state$,
            filter((state) => {
              const isFullySynced =
                state.dust.isSynced === true &&
                state.shielded.isSynced === true &&
                state.unshielded.isSynced === true;

              logger.info(`isFullySynced to pick up tasks: ${isFullySynced}`);

              return (
                isFullySynced &&
                state.unshielded.syncProgress?.highestTransactionId -
                  state.unshielded.syncProgress?.appliedId <=
                  50n &&
                state.unshielded.availableBalance > 2n * BigInt(faucet.dropAmount)
              );
            }),
            map((state) => state.unshielded.availableBalance),
            filter((balance) => balance > 0),
            debounceTime(200),
            firstL,
          );

          const makeRequestT = Task.lift(async () => {
            return faucet.requestTokens(
              await getWalletAddress(receiverWallet, faucetConfig.networkId),
              {
                event: "Initial request",
              },
            );
          });

          const receiverStateT = pipe(
            receiverWallet.state(),
            filter((state) => (state.unshielded.balances[unshieldedToken().raw] ?? 0n) > 0n),
            distinctUntilChanged(
              (state1, state2) =>
                state1.unshielded.balances[unshieldedToken().raw] ===
                state2.unshielded.balances[unshieldedToken().raw],
            ),
            debounceTime(200),
            firstL,
          );

          return pipe(
            faucetBalanceT,
            Task.flatMap((initialBalance) => {
              return pipe(
                makeRequestT,
                Task.flatMap(() => receiverStateT),
                Task.map((receiverState) => ({ receiverState, initialBalance })),
              );
            }),
            Task.tap((results) => {
              expect(results.initialBalance).toBe(env.genesisBalance);
              expect(results.receiverState.unshielded.balances[unshieldedToken().raw]).toBe(
                faucet.dropAmount,
              );
              expect(results.receiverState.unshielded.availableCoins.length).toBe(
                faucetConfig.numberOfOutputs,
              );
            }),
          );
        }),
        Task.unsafeRun,
      );
    },
    TX_PROCESSING_DELAY,
  );

  describe("service check", () => {
    const logger = pino(
      {
        level: "trace",
      },
      pinoPretty({ colorize: true }),
    );
    // Using tasks below to delay accessing `env` variable

    it.each([
      { url: Task.delay(() => new URL("/foo", env.urls.provingServerURL)), name: "provingServer" },
      { url: Task.delay(() => new URL("/foo", env.urls.indexerURL)), name: "indexer" },
      { url: Task.delay(() => new URL("/foo", env.urls.nodeURL)), name: "node" },
    ])(`fail on 4xx code from $name`, async ({ url, name }) => {
      await pipe(
        url,
        Task.flatMapPromise((urlToCheck: URL) => doCheck(name, urlToCheck)(logger)),
        Task.attempt,
        Task.tap((result) => expect(either.isLeft(result)).toBe(true)),
        Task.unsafeRun,
      );
    });

    it.each(
      [
        {
          url: Task.delay(() => new URL("/health", env.urls.provingServerURL)),
          name: "proving server",
        },
        { url: Task.delay(() => new URL("/health", env.urls.indexerURL)), name: "indexer" },
        { url: Task.delay(() => new URL("/health", env.urls.nodeURL)), name: "node" },
      ].map((item) => {
        return {
          ...item,
          url: pipe(
            item.url,
            Task.map((url) => {
              const out = new URL(url);
              out.protocol = "https";
              return out;
            }),
          ),
        };
      }),
    )("fail on wrong protocol being used with $name", async ({ url, name }) => {
      await pipe(
        url,
        Task.flatMapPromise((urlToCheck: URL) => doCheck(name, urlToCheck)(logger)),
        Task.attempt,
        Task.tap((result) => expect(either.isLeft(result)).toBe(true)),
        Task.unsafeRun,
      );
    });
  });
});

describe("FaucetImpl - Memoization and Validation", () => {
  const createMockLogger = () =>
    pino({
      level: "silent",
    });

  describe("InsufficientFundsError", () => {
    it("should create error with transfer value", () => {
      const transferValue = 1000n;
      const error = new InsufficientFundsError(transferValue);

      expect(error).toBeInstanceOf(Error);
      expect(error.transferValue).toBe(transferValue);
      expect(error.message).toContain("1000");
    });

    it("should accept cause option", () => {
      const transferValue = 1000n;
      const cause = new Error("Wallet error");
      const error = new InsufficientFundsError(transferValue, { cause });

      expect(error.cause).toBe(cause);
    });

    it("should detect wallet insufficient funds errors", () => {
      const walletError = new Error("Not sufficient funds to balance token: some_token_id");
      expect(InsufficientFundsError.doesWalletErrorMatch(walletError)).toBe(true);
    });

    it("should not match unrelated errors", () => {
      const error = new Error("Some other error");
      expect(InsufficientFundsError.doesWalletErrorMatch(error)).toBe(false);
    });
  });

  describe("calculateFaucetState", () => {
    it("should handle empty coin arrays", () => {
      const mockState = {
        unshielded: {
          address: new Uint8Array(32),
          balances: { raw: 0n },
          availableCoins: [],
          totalCoins: [],
          pendingCoins: [],
          progress: {
            appliedIndex: 0n,
            highestRelevantWalletIndex: 0n,
            highestIndex: 0n,
            highestRelevantIndex: 0n,
            isConnected: true,
            isStrictlyComplete: vi.fn().mockReturnValue(true),
            isCompleteWithin: vi.fn().mockReturnValue(true),
          },
        },
        shielded: {
          address: new Uint8Array(32),
          balances: { raw: 0n },
          availableCoins: [],
          totalCoins: [],
          pendingCoins: [],
          progress: {
            appliedIndex: 0n,
            highestRelevantWalletIndex: 0n,
            highestIndex: 0n,
            highestRelevantIndex: 0n,
            isConnected: true,
            isStrictlyComplete: vi.fn().mockReturnValue(true),
            isCompleteWithin: vi.fn().mockReturnValue(true),
          },
        },
        dust: {
          availableCoins: [],
          totalCoins: [],
          pendingCoins: [],
          balance: () => 0n,
          progress: {
            appliedIndex: 0n,
            highestRelevantWalletIndex: 0n,
            highestIndex: 0n,
            highestRelevantIndex: 0n,
            isConnected: true,
            isStrictlyComplete: vi.fn().mockReturnValue(true),
            isCompleteWithin: vi.fn().mockReturnValue(true),
          },
        },
      };

      const faucetState = calculateFaucetState(mockState as any);

      expect(faucetState.unshielded.availableCoins).toEqual([]);
      expect(faucetState.unshielded.totalCoins).toEqual([]);
      expect(faucetState.unshielded.pendingCoins).toEqual([]);
    });
  });

  describe("Coin snapshot and freshness validation", () => {
    it("should identify coin by intentHash and outputNo", () => {
      const coin = { utxo: { intentHash: "hash123", outputNo: 42n, value: 100n } };
      const coinId = `${coin.utxo.intentHash}#${coin.utxo.outputNo}`;

      expect(coinId).toBe("hash123#42");
    });

    it("should detect when coin no longer exists", () => {
      const originalCoins = [
        { utxo: { intentHash: "hash1", outputNo: 0n, value: 100n } },
        { utxo: { intentHash: "hash2", outputNo: 0n, value: 200n } },
      ];

      const snapshot = new Set(originalCoins.map((c) => `${c.utxo.intentHash}#${c.utxo.outputNo}`));

      const currentCoins = [{ utxo: { intentHash: "hash2", outputNo: 0n, value: 200n } }];

      const stillAvailable = currentCoins.some((c) =>
        snapshot.has(`${c.utxo.intentHash}#${c.utxo.outputNo}`),
      );

      expect(stillAvailable).toBe(true);

      const hasHash1 = currentCoins.some(
        (c) =>
          snapshot.has(`${c.utxo.intentHash}#${c.utxo.outputNo}`) && c.utxo.intentHash === "hash1",
      );

      expect(hasHash1).toBe(false);
    });

    it("should handle empty coin snapshot", () => {
      const emptyCoins = [] as any[];
      const snapshot = new Set(emptyCoins.map((c) => `${c.utxo.intentHash}#${c.utxo.outputNo}`));

      expect(snapshot.size).toBe(0);

      const stillAvailable = emptyCoins.some((c) =>
        snapshot.has(`${c.utxo.intentHash}#${c.utxo.outputNo}`),
      );

      expect(stillAvailable).toBe(false);
    });
  });

  describe("Transaction history validation", () => {
    it("should find SUCCESS status in history", () => {
      const history = [
        { status: "PENDING", hash: "hash1" },
        { status: "SUCCESS", hash: "hash2" },
        { status: "FAILED", hash: "hash3" },
      ];

      const successEntry = history.find(
        (entry) => entry !== undefined && entry.status === "SUCCESS",
      );

      expect(successEntry).toEqual({ status: "SUCCESS", hash: "hash2" });
    });

    it("should handle undefined history entries", () => {
      const entries = [undefined, undefined, { status: "SUCCESS", hash: "hash1" }];

      const successEntry = entries.find(
        (entry) => entry !== undefined && entry.status === "SUCCESS",
      );

      expect(successEntry).toEqual({ status: "SUCCESS", hash: "hash1" });
    });

    it("should not match non-SUCCESS statuses", () => {
      const history = [
        { status: "PENDING", hash: "hash1" },
        { status: "FAILED", hash: "hash3" },
      ];

      const successEntry = history.find(
        (entry) => entry !== undefined && entry.status === "SUCCESS",
      );

      expect(successEntry).toBeUndefined();
    });
  });

  describe("getFaucetState - memoization behavior", () => {
    it("should emit faucet state when wallet emits", async () => {
      const logger = createMockLogger();
      const mockState = {
        unshielded: {
          address: new Uint8Array(32),
          balances: { raw: 100n },
          availableCoins: [],
          totalCoins: [],
          pendingCoins: [],
          progress: {
            appliedIndex: 0n,
            highestRelevantWalletIndex: 0n,
            highestIndex: 0n,
            highestRelevantIndex: 0n,
            isConnected: true,
            isStrictlyComplete: vi.fn().mockReturnValue(true),
            isCompleteWithin: vi.fn().mockReturnValue(true),
          },
        },
        shielded: {
          address: new Uint8Array(32),
          balances: { raw: 0n },
          availableCoins: [],
          totalCoins: [],
          pendingCoins: [],
          progress: {
            appliedIndex: 0n,
            highestRelevantWalletIndex: 0n,
            highestIndex: 0n,
            highestRelevantIndex: 0n,
            isConnected: true,
            isStrictlyComplete: vi.fn().mockReturnValue(true),
            isCompleteWithin: vi.fn().mockReturnValue(true),
          },
        },
        dust: {
          availableCoins: [],
          totalCoins: [],
          pendingCoins: [],
          balance: () => 0n,
          progress: {
            appliedIndex: 0n,
            highestRelevantWalletIndex: 0n,
            highestIndex: 0n,
            highestRelevantIndex: 0n,
            isConnected: true,
            isStrictlyComplete: vi.fn().mockReturnValue(true),
            isCompleteWithin: vi.fn().mockReturnValue(true),
          },
        },
      };

      const stateSubject = new BehaviorSubject(mockState);
      const mockWallet = {
        state: () => stateSubject.asObservable(),
      };

      const faucetStateObs = getFaucetState(logger, mockWallet as any);
      const states: any[] = [];

      const subscription = faucetStateObs
        .pipe(filter(() => states.length < 2))
        .subscribe((state) => {
          states.push(state);
        });

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(states.length).toBeGreaterThan(0);
      expect(states[0].unshielded).toBeDefined();

      subscription.unsubscribe();
    });

    it("should apply auditTime throttling", async () => {
      const logger = createMockLogger();
      const stateSubject = new BehaviorSubject({
        unshielded: {
          address: new Uint8Array(32),
          balances: { raw: 0n },
          availableCoins: [],
          totalCoins: [],
          pendingCoins: [],
          progress: {
            appliedIndex: 0n,
            highestRelevantWalletIndex: 0n,
            highestIndex: 0n,
            highestRelevantIndex: 0n,
            isConnected: true,
            isStrictlyComplete: vi.fn().mockReturnValue(true),
            isCompleteWithin: vi.fn().mockReturnValue(true),
          },
        },
        shielded: {
          address: new Uint8Array(32),
          balances: { raw: 0n },
          availableCoins: [],
          totalCoins: [],
          pendingCoins: [],
          progress: {
            appliedIndex: 0n,
            highestRelevantWalletIndex: 0n,
            highestIndex: 0n,
            highestRelevantIndex: 0n,
            isConnected: true,
            isStrictlyComplete: vi.fn().mockReturnValue(true),
            isCompleteWithin: vi.fn().mockReturnValue(true),
          },
        },
        dust: {
          availableCoins: [],
          totalCoins: [],
          pendingCoins: [],
          balance: () => 0n,
          progress: {
            appliedIndex: 0n,
            highestRelevantWalletIndex: 0n,
            highestIndex: 0n,
            highestRelevantIndex: 0n,
            isConnected: true,
            isStrictlyComplete: vi.fn().mockReturnValue(true),
            isCompleteWithin: vi.fn().mockReturnValue(true),
          },
        },
      });

      const mockWallet = {
        state: () => stateSubject.asObservable(),
      };

      const faucetStateObs = getFaucetState(logger, mockWallet as any);
      let emissionCount = 0;

      const subscription = faucetStateObs.subscribe(() => {
        emissionCount++;
      });

      for (let i = 0; i < 10; i++) {
        stateSubject.next(stateSubject.value);
      }

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(emissionCount).toBeLessThan(10);

      subscription.unsubscribe();
    });
  });
});
