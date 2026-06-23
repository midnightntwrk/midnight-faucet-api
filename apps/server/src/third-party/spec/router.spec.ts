/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { calculateFaucetState, getFaucetState, WalletState } from "@midnight-ntwrk/faucet";
import { User, UserId } from "@midnight-ntwrk/faucet-auth";
import {
  Faucet,
  FaucetState,
  DripResponse,
  DripHealthResponse,
  TokenResponse,
  WalletAddress,
} from "@midnight-ntwrk/faucet-internal-api";
import { pipe, Resource, Task } from "@midnight-ntwrk/faucet-utils";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knexLib from "knex";
import { Duration } from "luxon";
import * as nodeCrypto from "node:crypto";
import pino from "pino";
import pinoPretty from "pino-pretty";
import { of, BehaviorSubject, EMPTY } from "rxjs";
import { ZswapSecretKeys } from "@midnightntwrk/ledger-v9";
import { UnshieldedAddress, MidnightBech32m } from "@midnightntwrk/wallet-sdk-address-format";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import { prepareAuthContext } from "../../auth/authContext.js";
import { PostgresqlUserRepository } from "../../auth/postgresql-user-repository.js";
import { defaultRoot, CompositionRoot } from "../../composition-root.js";
import { loadConfig, ServerConfig } from "../../config.js";
import { knexResource, runMigrations } from "../../postgres.js";
import { prepareServer } from "../../server.js";
import { statePersistenceStatus } from "../../metrics/index.js";

const logger = pino({ level: "error" }, pinoPretty({ colorize: true }));

describe("Third-Party API", () => {
  const getConfig = (container: StartedPostgreSqlContainer): ServerConfig => {
    const postgresqlConfig = {
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      password: container.getPassword(),
      user: container.getUsername(),
    };

    const defaultConfig = loadConfig();
    return {
      ...defaultConfig,
      // Use a different port to avoid conflict with server.spec.ts tests running in parallel
      port: 5400,
      db: {
        ...defaultConfig.db,
        ...postgresqlConfig,
      },
      logging: {
        level: "error",
        format: "pretty",
      },
      tasks: {
        ...defaultConfig.tasks,
        pollTime: 1,
      },
      thirdPartyApi: {
        allowedOrigins: ["https://partner.com", "https://allowed.example.com"],
        maxAmount: 1000,
        apiKey: "test-api-key-12345",
      },
    };
  };

  const testUsername = "test";
  const testPassword = "testPassword";

  const parsed = MidnightBech32m.parse(
    "mn_addr_undeployed1qpfkp8dd8xpv57t3sf0p5cex8a37qz40kjlz7hke3aq6mfk2pkyshz6pq0",
  );
  const unshieldedAddress = UnshieldedAddress.codec.decode(NetworkId.NetworkId.Undeployed, parsed);

  const cachedState = {
    shielded: {
      address: "mn_addr_undeployed1dlv8dtj72cjhyrxynqn0ul8ct6jlc0fez6q9hvyj3p3k6urxncasewzfqz",
      availableCoins: [{ coin: { value: 50n } }, { coin: { value: 50n } }],
      totalCoins: [{ coin: { value: 50n } }, { coin: { value: 50n } }],
      pendingCoins: [{ coin: { value: 0n } }],
      balances: {
        "0000000000000000000000000000000000000000000000000000000000000000": 100000000n,
      },
      progress: {
        appliedIndex: 1n,
        highestRelevantWalletIndex: 1n,
        highestIndex: 1n,
        highestRelevantIndex: 1n,
        isConnected: true,
        isStrictlyComplete: vi.fn().mockReturnValue(true),
        isCompleteWithin: vi.fn().mockReturnValue(true),
      },
    },
    unshielded: {
      address: unshieldedAddress,
      availableCoins: [{ utxo: { value: 50n } }, { utxo: { value: 50n } }],
      totalCoins: [{ utxo: { value: 50n } }, { utxo: { value: 50n } }],
      pendingCoins: [{ utxo: { value: 0n } }],
      balances: {
        "0000000000000000000000000000000000000000000000000000000000000000": 100000000n,
      },
      progress: {
        highestTransactionId: 100n,
        appliedId: 100n,
        isConnected: true,
        isStrictlyComplete: vi.fn().mockReturnValue(true),
        isCompleteWithin: vi.fn().mockReturnValue(true),
      },
    },
    dust: {
      address: "mn_dust_undeployed1wvggp4jmr2ynq3xf5rzgshjqyxjmdg9sp8hke22tp8d8g5vrawnryf5gld6",
      availableCoins: [
        { token: { initialValue: 50n }, generatedNow: 50n },
        { token: { initialValue: 50n }, generatedNow: 50n },
      ],
      totalCoins: [
        { token: { initialValue: 50n }, generatedNow: 50n },
        { token: { initialValue: 50n }, generatedNow: 50n },
      ],
      pendingCoins: [{ token: { initialValue: 0n }, generatedNow: 0n }],
      balance: vi.fn().mockReturnValue(100n),
      progress: {
        appliedIndex: 1n,
        highestRelevantWalletIndex: 1n,
        highestIndex: 1n,
        highestRelevantIndex: 1n,
        isConnected: true,
        isStrictlyComplete: vi.fn().mockReturnValue(true),
        isCompleteWithin: vi.fn().mockReturnValue(true),
      },
    },
  } as unknown as WalletState;

  const fakeWallet = vi.fn().mockImplementation((cacheOverride = {}) => ({
    state: () => of({ ...cachedState, ...cacheOverride }),
    submitTransaction: vi.fn(),
    finalizeTransaction: vi.fn(),
    signTransaction: vi.fn(),
    transferTransaction: vi.fn(),
  }));

  const prepareFakeFaucet = (
    _config: ServerConfig,
    receiver: WalletAddress,
    responseDelay: number = 0,
  ) => {
    const runningTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();
    const resolveDelayed = <T>(value: T) =>
      new Promise<T>((resolve) => {
        const newTimeout = setTimeout(() => {
          resolve(value);
          runningTimeouts.delete(newTimeout);
        }, responseDelay);
        runningTimeouts.add(newTimeout);
      });

    const preparedResponse = {
      transactionIdentifier: nodeCrypto.randomBytes(32).toString("hex"),
      timeToNextRequest: Duration.fromMillis(0),
    };

    const fakeFaucet: Task<Faucet> = Task.lift(async () => {
      const state$ = getFaucetState(logger, fakeWallet());
      const { firstValueFrom } = await import("rxjs");
      const initialState = await firstValueFrom(state$);

      return {
        requestTokens(address: WalletAddress): Promise<TokenResponse> {
          return address === receiver
            ? resolveDelayed<TokenResponse>(preparedResponse)
            : Promise.reject<TokenResponse>(new Error("Request from wrong address"));
        },
        dropAmount: "500",
        address: UnshieldedAddress.codec
          .encode(config.networkId, initialState.unshielded.address)
          .asString(),
        serializeWalletState: () => ({
          shielded: Promise.resolve(""),
          unshielded: Promise.resolve(""),
          dust: Promise.resolve(""),
        }),
        state$,
        syncErrors$: EMPTY,
      };
    });

    return {
      preparedResponse,
      faucet: Resource.make(fakeFaucet, () =>
        Task.delay(() => {
          runningTimeouts.forEach((timeout) => clearTimeout(timeout));
          runningTimeouts.clear();
        }),
      ),
    };
  };

  const prepareDb = () => {
    return Resource.make<StartedPostgreSqlContainer>(
      Task.lift(() => new PostgreSqlContainer("postgres:15.0").start()),
      (container) =>
        Task.lift(async () => {
          await container.stop({ remove: true, removeVolumes: true });
        }),
    );
  };

  const migrations = async (config: ServerConfig) => {
    const knexInstance = knexLib({
      client: "pg",
      connection: config.db,
      debug: true,
    });
    await runMigrations(knexInstance, logger);
  };

  const prepareData = async (config: ServerConfig) => {
    return pipe(
      knexResource(config.db, logger),
      Resource.mapPromise(async (knex) => {
        await knex("users").delete();
        await knex("user_action_times").delete();
        await knex("rate_counts").delete();
        await knex("tasks").delete();
        return new PostgresqlUserRepository(knex);
      }),
      Resource.map((u) => prepareAuthContext(config, u, logger)),
      Resource.use((context) =>
        Task.lift(async () => {
          const credentials = context.userAuth.generateStoredCredentials(testPassword);
          const user = new User(
            UserId.generate(),
            testUsername,
            credentials.salt,
            credentials.hashedPassword,
          );
          await context.userRepository.saveUser(user);
        }),
      ),
      Task.unsafeRun,
    );
  };

  const environment = pipe(
    prepareDb(),
    Resource.map(getConfig),
    Resource.mapPromise(async (config) => {
      await migrations(config);
      return config;
    }),
  );

  const getRandomBech32mAddress = () => {
    const keys = ZswapSecretKeys.fromSeedRng(nodeCrypto.randomBytes(32));
    const address = new UnshieldedAddress(Buffer.from(keys.coinPublicKey, "hex"));

    return UnshieldedAddress.codec.encode(config.networkId, address).asString();
  };

  let config: ServerConfig;
  let teardown: Task<void>;

  beforeAll(async () => {
    const allocated = await Task.unsafeRun(Resource.allocate(environment));
    config = allocated.value;
    teardown = allocated.teardown;
  });

  afterAll(async () => {
    await Task.unsafeRun(teardown);
  });

  beforeEach(async () => {
    await prepareData(config);
  });

  const allowedOrigin = "https://partner.com";
  const validApiKey = "test-api-key-12345";

  // Helper to mock healthService connectivity check (services not running in tests)
  const withMockedConnectivity = (root: CompositionRoot): CompositionRoot => {
    statePersistenceStatus.set(1);
    return {
      ...root,
      healthService: {
        ...root.healthService,
        doChecks: vi.fn().mockImplementation((key: "liveness" | "readiness" | "connectivity") => {
          if (key === "connectivity") {
            return Promise.resolve({ status: "ok", details: {} });
          }
          return root.healthService.doChecks(key);
        }),
      } as unknown as typeof root.healthService,
    };
  };

  describe("Origin Whitelist", () => {
    it("returns 403 when origin is not whitelisted", () => {
      const receiver = getRandomBech32mAddress();
      const { faucet } = prepareFakeFaucet(config, receiver);

      return pipe(
        defaultRoot(config, () => faucet),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(() =>
            fetch(`http://${config.host}:${config.port}/v1/drips`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: "https://unknown-origin.com",
              },
              body: JSON.stringify({ recipientAddress: receiver, amount: 1000 }),
            }).then((res) => res.json().then((body) => ({ response: res, responseBody: body }))),
          ),
        ),
        Task.tap((result) => {
          expect(result.response.status).toBe(403);
          expect(result.responseBody).toMatchObject({
            error: "Origin not allowed",
          });
        }),
        Task.unsafeRun,
      );
    });

    it("returns 403 when no origin header is provided", () => {
      const receiver = getRandomBech32mAddress();
      const { faucet } = prepareFakeFaucet(config, receiver);

      return pipe(
        defaultRoot(config, () => faucet),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(() =>
            fetch(`http://${config.host}:${config.port}/v1/drips`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ recipientAddress: receiver, amount: 1000 }),
            }).then((res) => res.json().then((body) => ({ response: res, responseBody: body }))),
          ),
        ),
        Task.tap((result) => {
          expect(result.response.status).toBe(403);
          expect(result.responseBody).toMatchObject({
            error: "Origin not allowed",
          });
        }),
        Task.unsafeRun,
      );
    });

    it("allows requests from whitelisted origins", () => {
      const receiver = getRandomBech32mAddress();
      const { faucet } = prepareFakeFaucet(config, receiver);

      return pipe(
        defaultRoot(config, () => faucet),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(() =>
            fetch(`http://${config.host}:${config.port}/v1/drips`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: allowedOrigin,
                "X-API-Key": validApiKey,
              },
              body: JSON.stringify({ recipientAddress: receiver, amount: "1000" }),
            }).then((res) => res.json().then((body) => ({ response: res, responseBody: body }))),
          ),
        ),
        Task.tap((result) => {
          expect(result.response.status).toBe(200);
          expect(result.responseBody).toHaveProperty("dripId");
          expect(result.responseBody).toHaveProperty("status", "PENDING");
        }),
        Task.unsafeRun,
      );
    });
  });

  describe("API Key Validation", () => {
    it("returns 401 when API key is missing", () => {
      const receiver = getRandomBech32mAddress();
      const { faucet } = prepareFakeFaucet(config, receiver);

      return pipe(
        defaultRoot(config, () => faucet),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(() =>
            fetch(`http://${config.host}:${config.port}/v1/drips`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: allowedOrigin,
              },
              body: JSON.stringify({ recipientAddress: receiver, amount: "1000" }),
            }).then((res) => res.json().then((body) => ({ response: res, responseBody: body }))),
          ),
        ),
        Task.tap((result) => {
          expect(result.response.status).toBe(401);
          expect(result.responseBody).toMatchObject({
            error: "API key required",
          });
        }),
        Task.unsafeRun,
      );
    });

    it("returns 403 when API key is invalid", () => {
      const receiver = getRandomBech32mAddress();
      const { faucet } = prepareFakeFaucet(config, receiver);

      return pipe(
        defaultRoot(config, () => faucet),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(() =>
            fetch(`http://${config.host}:${config.port}/v1/drips`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: allowedOrigin,
                "X-API-Key": "wrong-api-key",
              },
              body: JSON.stringify({ recipientAddress: receiver, amount: "1000" }),
            }).then((res) => res.json().then((body) => ({ response: res, responseBody: body }))),
          ),
        ),
        Task.tap((result) => {
          expect(result.response.status).toBe(403);
          expect(result.responseBody).toMatchObject({
            error: "Invalid API key",
          });
        }),
        Task.unsafeRun,
      );
    });
  });

  describe("POST /v1/drips", () => {
    it("returns 400 for amount exceeding max", () => {
      const receiver = getRandomBech32mAddress();
      const { faucet } = prepareFakeFaucet(config, receiver);

      return pipe(
        defaultRoot(config, () => faucet),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(() =>
            fetch(`http://${config.host}:${config.port}/v1/drips`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: allowedOrigin,
                "X-API-Key": validApiKey,
              },
              body: JSON.stringify({ recipientAddress: receiver, amount: "2000" }),
            }).then((res) => res.json().then((body) => ({ response: res, responseBody: body }))),
          ),
        ),
        Task.tap((result) => {
          expect(result.response.status).toBe(400);
          expect(result.responseBody.error).toContain("Invalid amount");
        }),
        Task.unsafeRun,
      );
    });

    it("returns 400 for zero or negative amount", () => {
      const receiver = getRandomBech32mAddress();
      const { faucet } = prepareFakeFaucet(config, receiver);

      return pipe(
        defaultRoot(config, () => faucet),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(() =>
            fetch(`http://${config.host}:${config.port}/v1/drips`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: allowedOrigin,
                "X-API-Key": validApiKey,
              },
              body: JSON.stringify({ recipientAddress: receiver, amount: "0" }),
            }).then((res) => res.json().then((body) => ({ response: res, responseBody: body }))),
          ),
        ),
        Task.tap((result) => {
          expect(result.response.status).toBe(400);
          expect(result.responseBody.error).toContain("Invalid amount");
        }),
        Task.unsafeRun,
      );
    });

    it("returns 400 for invalid address format", () => {
      const { faucet } = prepareFakeFaucet(config, getRandomBech32mAddress());

      return pipe(
        defaultRoot(config, () => faucet),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(() =>
            fetch(`http://${config.host}:${config.port}/v1/drips`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: allowedOrigin,
                "X-API-Key": validApiKey,
              },
              body: JSON.stringify({ recipientAddress: "invalid_address", amount: "1000" }),
            }).then((res) => res.json().then((body) => ({ response: res, responseBody: body }))),
          ),
        ),
        Task.tap((result) => {
          expect(result.response.status).toBe(400);
        }),
        Task.unsafeRun,
      );
    });

    it("returns 400 for missing fields", () => {
      const { faucet } = prepareFakeFaucet(config, getRandomBech32mAddress());

      return pipe(
        defaultRoot(config, () => faucet),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(() =>
            fetch(`http://${config.host}:${config.port}/v1/drips`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: allowedOrigin,
                "X-API-Key": validApiKey,
              },
              body: JSON.stringify({}),
            }).then((res) => res.json().then((body) => ({ response: res, responseBody: body }))),
          ),
        ),
        Task.tap((result) => {
          expect(result.response.status).toBe(400);
        }),
        Task.unsafeRun,
      );
    });

    it("returns dripId and PENDING status on success", () => {
      const receiver = getRandomBech32mAddress();
      const { faucet } = prepareFakeFaucet(config, receiver);

      return pipe(
        defaultRoot(config, () => faucet),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(() =>
            fetch(`http://${config.host}:${config.port}/v1/drips`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: allowedOrigin,
                "X-API-Key": validApiKey,
              },
              body: JSON.stringify({ recipientAddress: receiver, amount: "1000" }),
            }).then((res) => res.json()),
          ),
        ),
        Task.tap((result: DripResponse) => {
          expect(result.dripId).toBeDefined();
          expect(typeof result.dripId).toBe("string");
          expect(result.status).toBe("PENDING");
          expect(result.transactionHash).toBeNull();
          expect(result.error).toBeNull();
        }),
        Task.unsafeRun,
      );
    });

    it("returns 429 when rate limit is exceeded", () => {
      const receiver = getRandomBech32mAddress();
      const { faucet } = prepareFakeFaucet(config, receiver);
      const limitedConfig = {
        ...config,
        rateLimiting: {
          ...config.rateLimiting,
          maxDailyRequests: 1,
        },
      };

      return pipe(
        defaultRoot(limitedConfig, () => faucet),
        Resource.flatMap((root) => prepareServer(limitedConfig, root)),
        Resource.use(() =>
          Task.lift(async () => {
            // First request should succeed
            const first = await fetch(
              `http://${limitedConfig.host}:${limitedConfig.port}/v1/drips`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Origin: allowedOrigin,
                  "X-API-Key": validApiKey,
                },
                body: JSON.stringify({ recipientAddress: receiver, amount: "1000" }),
              },
            );
            expect(first.status).toBe(200);
            const firstResult = await first.json();

            // Wait for the first request to complete and poll its status
            // Rate count is only incremented when status is polled as SUCCESS
            const pollForCompletion = async (dripId: string, maxAttempts = 30): Promise<void> => {
              for (let i = 0; i < maxAttempts; i++) {
                const statusRes = await fetch(
                  `http://${limitedConfig.host}:${limitedConfig.port}/v1/drips/${dripId}`,
                  { headers: { Origin: allowedOrigin, "X-API-Key": validApiKey } },
                );
                const status = await statusRes.json();
                if (status.status === "CONFIRMED" || status.status === "FAILED") {
                  return;
                }
                await new Promise((resolve) => setTimeout(resolve, 200));
              }
            };

            await pollForCompletion(firstResult.dripId);

            // Second request should be rate limited
            const second = await fetch(
              `http://${limitedConfig.host}:${limitedConfig.port}/v1/drips`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Origin: allowedOrigin,
                  "X-API-Key": validApiKey,
                },
                body: JSON.stringify({ recipientAddress: receiver, amount: "1000" }),
              },
            );
            return { response: second, responseBody: await second.json() };
          }),
        ),
        Task.tap((result) => {
          expect(result.response.status).toBe(429);
        }),
        Task.unsafeRun,
      );
    });
  });

  describe("GET /v1/drips/:dripId", () => {
    it("returns drip status for valid dripId", () => {
      const receiver = getRandomBech32mAddress();
      const { faucet } = prepareFakeFaucet(config, receiver);

      return pipe(
        defaultRoot(config, () => faucet),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(async () => {
            // First create a drip
            const createResponse = await fetch(`http://${config.host}:${config.port}/v1/drips`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: allowedOrigin,
                "X-API-Key": validApiKey,
              },
              body: JSON.stringify({ recipientAddress: receiver, amount: "1000" }),
            });
            const createResult = await createResponse.json();
            const dripId = createResult.dripId;

            // Then get its status
            const statusResponse = await fetch(
              `http://${config.host}:${config.port}/v1/drips/${dripId}`,
              {
                headers: {
                  Origin: allowedOrigin,
                  "X-API-Key": validApiKey,
                },
              },
            );
            return statusResponse.json();
          }),
        ),
        Task.tap((result: DripResponse) => {
          expect(result.dripId).toBeDefined();
          expect(["PENDING", "CONFIRMED", "FAILED"]).toContain(result.status);
        }),
        Task.unsafeRun,
      );
    });

    it("returns FAILED for non-existent dripId", () => {
      const receiver = getRandomBech32mAddress();
      const { faucet } = prepareFakeFaucet(config, receiver);

      return pipe(
        defaultRoot(config, () => faucet),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(() =>
            fetch(
              `http://${config.host}:${config.port}/v1/drips/00000000-0000-0000-0000-000000000000`,
              {
                headers: {
                  Origin: allowedOrigin,
                  "X-API-Key": validApiKey,
                },
              },
            ).then((res) => res.json()),
          ),
        ),
        Task.tap((result: DripResponse) => {
          expect(result.status).toBe("FAILED");
          expect(result.error).toBeDefined();
        }),
        Task.unsafeRun,
      );
    });
  });

  describe("GET /v1/health", () => {
    it("returns SERVING when wallet is synced and has balance", () => {
      const receiver = getRandomBech32mAddress();
      const { faucet } = prepareFakeFaucet(config, receiver);

      return pipe(
        defaultRoot(config, () => faucet),
        Resource.map(withMockedConnectivity),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(() =>
            fetch(`http://${config.host}:${config.port}/v1/health`, {
              headers: {
                Origin: allowedOrigin,
                "X-API-Key": validApiKey,
              },
            }).then((res) => res.json()),
          ),
        ),
        Task.tap((result: DripHealthResponse) => {
          expect(result.status).toBe("SERVING");
          expect(result.reason).toBeNull();
        }),
        Task.unsafeRun,
      );
    });

    it("returns NOT_SERVING with reason when wallet is not synced", () => {
      const unsyncedState = {
        ...cachedState,
        unshielded: {
          ...cachedState.unshielded,
          progress: {
            ...cachedState.unshielded.progress,
            // Readiness check fails when highestTransactionId - appliedId > 200n
            highestTransactionId: 500n,
            appliedId: 100n,
            isStrictlyComplete: vi.fn().mockReturnValue(false),
          },
        },
      } as unknown as WalletState;

      const state$ = new BehaviorSubject<FaucetState>(calculateFaucetState(unsyncedState));

      const mockFaucet: Faucet = {
        requestTokens(): Promise<TokenResponse> {
          return Promise.resolve({
            transactionIdentifier: nodeCrypto.randomBytes(32).toString("hex"),
            timeToNextRequest: Duration.fromMillis(0),
          });
        },
        dropAmount: "500",
        address: getRandomBech32mAddress(),
        state$,
        syncErrors$: EMPTY,
        serializeWalletState: () => ({
          shielded: Promise.resolve(""),
          unshielded: Promise.resolve(""),
          dust: Promise.resolve(""),
        }),
      };

      return pipe(
        defaultRoot(config, () => Resource.of(mockFaucet)),
        Resource.map(withMockedConnectivity),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(() =>
            fetch(`http://${config.host}:${config.port}/v1/health`, {
              headers: {
                Origin: allowedOrigin,
                "X-API-Key": validApiKey,
              },
            }).then((res) => res.json()),
          ),
        ),
        Task.tap((result: DripHealthResponse) => {
          expect(result.status).toBe("NOT_SERVING");
          expect(result.reason).toBeDefined();
        }),
        Task.unsafeRun,
      );
    });

    it("returns NOT_SERVING when wallet balance is low", () => {
      const lowBalanceState = {
        ...cachedState,
        unshielded: {
          address: unshieldedAddress,
          availableCoins: [{ utxo: { value: 50n } }],
          totalCoins: [{ utxo: { value: 50n } }],
          pendingCoins: [],
          balances: {
            "0000000000000000000000000000000000000000000000000000000000000000": 50n,
          },
          progress: {
            highestTransactionId: 100n,
            appliedId: 100n,
            isConnected: true,
            isStrictlyComplete: vi.fn().mockReturnValue(true),
            isCompleteWithin: vi.fn().mockReturnValue(true),
          },
        },
      } as unknown as WalletState;

      const state$ = new BehaviorSubject<FaucetState>(calculateFaucetState(lowBalanceState));

      const mockFaucet: Faucet = {
        requestTokens(): Promise<TokenResponse> {
          return Promise.resolve({
            transactionIdentifier: nodeCrypto.randomBytes(32).toString("hex"),
            timeToNextRequest: Duration.fromMillis(0),
          });
        },
        dropAmount: "500",
        address: getRandomBech32mAddress(),
        state$,
        syncErrors$: EMPTY,
        serializeWalletState: () => ({
          shielded: Promise.resolve(""),
          unshielded: Promise.resolve(""),
          dust: Promise.resolve(""),
        }),
      };

      return pipe(
        defaultRoot(config, () => Resource.of(mockFaucet)),
        Resource.map(withMockedConnectivity),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          Task.lift(() =>
            fetch(`http://${config.host}:${config.port}/v1/health`, {
              headers: {
                Origin: allowedOrigin,
                "X-API-Key": validApiKey,
              },
            }).then((res) => res.json()),
          ),
        ),
        Task.tap((result: DripHealthResponse) => {
          expect(result.status).toBe("NOT_SERVING");
          expect(result.reason).toBe("WALLET_BALANCE_LOW");
        }),
        Task.unsafeRun,
      );
    });
  });
});
