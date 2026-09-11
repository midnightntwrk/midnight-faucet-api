/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { calculateFaucetState, getFaucetState, WalletState } from "@midnightntwrk/faucet";
import { User, UserId } from "@midnightntwrk/faucet-auth";
import {
  Faucet,
  FaucetState,
  TokenResponse,
  WalletAddress,
} from "@midnightntwrk/faucet-internal-api";
import { pipe, Resource, Task } from "@midnightntwrk/faucet-utils";
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
  /** The key the server is configured with and the one the tests send: one value, so they cannot drift. */
  const validApiKey = "test-api-key-12345";

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
        requireOrigin: false,
        network: "midnight_undeployed",
        token: "tNIGHT",
        maxAmount: "5000000000",
        defaultAmount: "5000000",
        apiKey: validApiKey,
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

  const baseUrl = () => `http://${config.host}:${config.port}/v1`;

  const partnerHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": validApiKey,
  };

  const withOrigin = (headers: Record<string, string>): Record<string, string> => ({
    ...headers,
    Origin: allowedOrigin,
  });

  /** A body the API accepts, before a test spoils one field of it. */
  const validBody = (receiver: string, overrides: Record<string, unknown> = {}) => ({
    recipientAddress: receiver,
    network: config.thirdPartyApi.network,
    token: config.thirdPartyApi.token,
    amount: "1000",
    ...overrides,
  });

  const post = (body: unknown, headers: Record<string, string> = partnerHeaders) =>
    fetch(`${baseUrl()}/drips`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }).then(async (response) => ({ response, body: await response.json() }));

  const get = (path: string, headers: Record<string, string> = partnerHeaders) =>
    fetch(`${baseUrl()}${path}`, { headers }).then(async (response) => ({
      response,
      body: await response.json(),
    }));

  type FaucetResource = Parameters<typeof defaultRoot>[1];

  /**
   * Runs `use` against a server built from `serverConfig`, with connectivity
   * mocked — the indexer and node the real check dials are not running here.
   */
  const withServer = <A>(
    serverConfig: ServerConfig,
    faucet: FaucetResource,
    use: () => Promise<A>,
  ): Promise<A> =>
    pipe(
      defaultRoot(serverConfig, faucet),
      Resource.map(withMockedConnectivity),
      Resource.flatMap((root) => prepareServer(serverConfig, root)),
      Resource.use(() => Task.lift(use)),
      Task.unsafeRun,
    );

  const faucetFor = (receiver: string): FaucetResource => {
    const { faucet } = prepareFakeFaucet(config, receiver);
    return () => faucet;
  };

  /** A faucet whose wallet is in `state`, for the health-driven paths. */
  const faucetInState = (state: WalletState): FaucetResource => {
    const state$ = new BehaviorSubject<FaucetState>(calculateFaucetState(state));
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
    return () => Resource.of(mockFaucet);
  };

  const unsyncedState = () =>
    ({
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
    }) as unknown as WalletState;

  const lowBalanceState = () =>
    ({
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
    }) as unknown as WalletState;

  const pollUntilSettled = async (dripId: string, attempts = 60): Promise<string> => {
    const status = await get(`/drips/${dripId}`).then((result) => result.body.status as string);
    if (status === "CONFIRMED" || status === "FAILED" || attempts <= 1) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    return pollUntilSettled(dripId, attempts - 1);
  };

  describe("Authentication", () => {
    it("returns 401 INVALID_API_KEY when the key is missing", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), () =>
        post(validBody(receiver), { "Content-Type": "application/json" }),
      );

      expect(result.response.status).toBe(401);
      expect(result.body).toMatchObject({ error: { code: "INVALID_API_KEY" } });
    });

    it("returns 401 INVALID_API_KEY when the key is wrong", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), () =>
        post(validBody(receiver), {
          "Content-Type": "application/json",
          "X-API-Key": "wrong-api-key",
        }),
      );

      expect(result.response.status).toBe(401);
      expect(result.body).toMatchObject({ error: { code: "INVALID_API_KEY" } });
    });

    // The integration this API exists for is server-to-server, and a backend
    // sends no Origin header at all.
    it("accepts a request with no Origin header", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), () => post(validBody(receiver)));

      expect(result.response.status).toBe(200);
      expect(result.body).toHaveProperty("dripId");
    });
  });

  describe("Origin allow-list (when enforced)", () => {
    const strictConfig = (): ServerConfig => ({
      ...config,
      thirdPartyApi: { ...config.thirdPartyApi, requireOrigin: true },
    });

    it("rejects a request with no Origin header", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(strictConfig(), faucetFor(receiver), () =>
        post(validBody(receiver)),
      );

      expect(result.response.status).toBe(403);
      expect(result.body).toMatchObject({ error: { code: "VERIFICATION_REJECTED" } });
    });

    it("rejects an origin outside the allow-list", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(strictConfig(), faucetFor(receiver), () =>
        post(validBody(receiver), {
          ...partnerHeaders,
          Origin: "https://unknown-origin.com",
        }),
      );

      expect(result.response.status).toBe(403);
      expect(result.body).toMatchObject({ error: { code: "VERIFICATION_REJECTED" } });
    });

    it("allows an origin on the allow-list", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(strictConfig(), faucetFor(receiver), () =>
        post(validBody(receiver), withOrigin(partnerHeaders)),
      );

      expect(result.response.status).toBe(200);
      expect(result.body).toHaveProperty("dripId");
    });
  });

  describe("POST /v1/drips", () => {
    it("answers with the dripId alone", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), () => post(validBody(receiver)));

      expect(result.response.status).toBe(200);
      expect(typeof result.body.dripId).toBe("string");
      // The spec's success body is exactly `{ dripId }` — the status fields the
      // public API returns here would be read as part of the contract.
      expect(Object.keys(result.body)).toEqual(["dripId"]);
    });

    it("accepts a request that omits the amount", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), () =>
        post(validBody(receiver, { amount: undefined })),
      );

      expect(result.response.status).toBe(200);
      expect(result.body).toHaveProperty("dripId");
    });

    it("accepts a null amount", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), () =>
        post(validBody(receiver, { amount: null })),
      );

      expect(result.response.status).toBe(200);
    });

    it("accepts an opaque fulfillmentContext", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), () =>
        post(validBody(receiver, { fulfillmentContext: { receipt: "abc", nested: { ok: true } } })),
      );

      expect(result.response.status).toBe(200);
      expect(result.body).toHaveProperty("dripId");
    });

    it("matches network and token case-insensitively", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), () =>
        post(
          validBody(receiver, {
            network: config.thirdPartyApi.network.toUpperCase(),
            token: config.thirdPartyApi.token.toUpperCase(),
          }),
        ),
      );

      expect(result.response.status).toBe(200);
    });

    it("returns 400 UNSUPPORTED_NETWORK for another network", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), () =>
        post(validBody(receiver, { network: "ethereum_testnet" })),
      );

      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code: "UNSUPPORTED_NETWORK" } });
    });

    it("returns 400 UNSUPPORTED_TOKEN for another token", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), () =>
        post(validBody(receiver, { token: "ETH" })),
      );

      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code: "UNSUPPORTED_TOKEN" } });
    });

    it("returns 400 INVALID_ADDRESS for a malformed address", async () => {
      const result = await withServer(config, faucetFor(getRandomBech32mAddress()), () =>
        post(validBody("not-a-valid-address")),
      );

      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code: "INVALID_ADDRESS" } });
    });

    it("returns 400 INVALID_REQUEST when required fields are missing", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), () =>
        post({ recipientAddress: receiver }),
      );

      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    });

    it("returns 400 INVALID_REQUEST for a non-numeric amount", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), () =>
        post(validBody(receiver, { amount: "not-a-number" })),
      );

      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    });

    it("returns 400 INVALID_REQUEST for an amount above the maximum", async () => {
      const receiver = getRandomBech32mAddress();
      const overMax = (BigInt(config.thirdPartyApi.maxAmount) + 1n).toString();
      const result = await withServer(config, faucetFor(receiver), () =>
        post(validBody(receiver, { amount: overMax })),
      );

      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    });

    it("returns 400 INVALID_REQUEST for a zero amount", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), () =>
        post(validBody(receiver, { amount: "0" })),
      );

      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    });

    // Answering a retry with the id of the drip already in flight keeps the call
    // idempotent, and is what stops a double submit dispensing twice.
    it("answers a duplicate in-flight request with the same dripId", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), async () => {
        const first = await post(validBody(receiver));
        const second = await post(validBody(receiver));
        return { first, second };
      });

      expect(result.first.response.status).toBe(200);
      expect(result.second.response.status).toBe(200);
      expect(result.second.body.dripId).toBe(result.first.body.dripId);
    });

    it("returns 429 RATE_LIMIT_EXCEEDED once the daily limit is spent", async () => {
      const receiver = getRandomBech32mAddress();
      const limitedConfig: ServerConfig = {
        ...config,
        rateLimiting: { ...config.rateLimiting, maxDailyRequests: 1 },
      };

      const result = await withServer(limitedConfig, faucetFor(receiver), async () => {
        const first = await post(validBody(receiver));
        expect(first.response.status).toBe(200);
        await pollUntilSettled(first.body.dripId as string);
        return post(validBody(receiver));
      });

      expect(result.response.status).toBe(429);
      expect(result.body).toMatchObject({ error: { code: "RATE_LIMIT_EXCEEDED" } });
    });

    // The partner route no longer shares the public route's handlers, so the
    // refund on a failed dispense has to be proven here in its own right.
    it("does not consume the daily rate limit when the dispense fails", async () => {
      const receiver = getRandomBech32mAddress();
      // The fake faucet rejects for any address other than the one it was built
      // for, which is the failure this needs: a valid request that registers and
      // whose drip then fails.
      const faucet = faucetFor(getRandomBech32mAddress());
      const limitedConfig: ServerConfig = {
        ...config,
        rateLimiting: { ...config.rateLimiting, maxDailyRequests: 1 },
      };

      const retry = await withServer(limitedConfig, faucet, async () => {
        const first = await post(validBody(receiver));
        expect(first.response.status).toBe(200);
        expect(await pollUntilSettled(first.body.dripId as string)).toBe("FAILED");

        // Nothing was dispensed, so the partner's daily allowance is intact.
        return post(validBody(receiver));
      });

      expect(retry.response.status).toBe(200);
    });

    it("returns 503 INSUFFICIENT_FUNDS when the wallet is drained", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetInState(lowBalanceState()), () =>
        post(validBody(receiver)),
      );

      expect(result.response.status).toBe(503);
      expect(result.body).toMatchObject({ error: { code: "INSUFFICIENT_FUNDS" } });
    });

    it("returns 503 SERVICE_UNAVAILABLE when the wallet is behind", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetInState(unsyncedState()), () =>
        post(validBody(receiver)),
      );

      expect(result.response.status).toBe(503);
      expect(result.body).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    });
  });

  describe("GET /v1/drips/:dripId", () => {
    it("reports a registered drip", async () => {
      const receiver = getRandomBech32mAddress();
      const result = await withServer(config, faucetFor(receiver), async () => {
        const created = await post(validBody(receiver));
        return get(`/drips/${created.body.dripId as string}`);
      });

      expect(result.response.status).toBe(200);
      expect(["PENDING", "CONFIRMED", "FAILED"]).toContain(result.body.status);
      expect(Object.keys(result.body).sort()).toEqual([
        "dripId",
        "error",
        "status",
        "transactionHash",
      ]);
    });

    it("answers 200 with an error object for an unknown dripId", async () => {
      const result = await withServer(config, faucetFor(getRandomBech32mAddress()), () =>
        get("/drips/00000000-0000-0000-0000-000000000000"),
      );

      expect(result.response.status).toBe(200);
      expect(result.body.status).toBe("FAILED");
      expect(result.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    });

    it("answers 200 with an error object for a malformed dripId", async () => {
      const result = await withServer(config, faucetFor(getRandomBech32mAddress()), () =>
        get("/drips/not-a-uuid"),
      );

      expect(result.response.status).toBe(200);
      expect(result.body.status).toBe("FAILED");
      expect(result.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    });
  });

  describe("GET /v1/drip-info/:network/:token", () => {
    it("reports the configured drip amount", async () => {
      const result = await withServer(config, faucetFor(getRandomBech32mAddress()), () =>
        get(`/drip-info/${config.thirdPartyApi.network}/${config.thirdPartyApi.token}`),
      );

      expect(result.response.status).toBe(200);
      expect(result.body).toEqual({ dripAmount: config.thirdPartyApi.defaultAmount });
    });

    it("returns 400 UNSUPPORTED_NETWORK for another network", async () => {
      const result = await withServer(config, faucetFor(getRandomBech32mAddress()), () =>
        get(`/drip-info/ethereum_testnet/${config.thirdPartyApi.token}`),
      );

      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code: "UNSUPPORTED_NETWORK" } });
    });

    it("returns 400 UNSUPPORTED_TOKEN for another token", async () => {
      const result = await withServer(config, faucetFor(getRandomBech32mAddress()), () =>
        get(`/drip-info/${config.thirdPartyApi.network}/ETH`),
      );

      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code: "UNSUPPORTED_TOKEN" } });
    });
  });

  describe("GET /v1/health", () => {
    it("reports SERVING when the wallet is synced and funded", async () => {
      const result = await withServer(config, faucetFor(getRandomBech32mAddress()), () =>
        get("/health"),
      );

      expect(result.response.status).toBe(200);
      expect(result.body).toEqual({ status: "SERVING", reason: null });
    });

    it("reports NODE_DESYNCED when the wallet is behind", async () => {
      const result = await withServer(config, faucetInState(unsyncedState()), () => get("/health"));

      // A poller reads the body, so the status stays 200 even when not serving.
      expect(result.response.status).toBe(200);
      expect(result.body).toEqual({ status: "NOT_SERVING", reason: "NODE_DESYNCED" });
    });

    it("reports WALLET_BALANCE_LOW when the wallet is drained", async () => {
      const result = await withServer(config, faucetInState(lowBalanceState()), () =>
        get("/health"),
      );

      expect(result.response.status).toBe(200);
      expect(result.body).toEqual({ status: "NOT_SERVING", reason: "WALLET_BALANCE_LOW" });
    });
  });
});
