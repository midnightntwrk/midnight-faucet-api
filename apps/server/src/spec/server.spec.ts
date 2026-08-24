/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { calculateFaucetState, getFaucetState, WalletState } from "@midnight-ntwrk/faucet";
import { User, UserId } from "@midnight-ntwrk/faucet-auth";
import { ClientError, FaucetClient } from "@midnight-ntwrk/faucet-client";
import {
  Faucet,
  FaucetState,
  DripResponse,
  dripResponseCodec,
  dripRequestCodec,
  TokenResponse,
  WalletAddress,
} from "@midnight-ntwrk/faucet-internal-api";
import { pipe, Resource, Task } from "@midnight-ntwrk/faucet-utils";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { either } from "fp-ts";
import knexLib from "knex";
import { Duration, DateTime, Settings } from "luxon";
import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "path";
import pino from "pino";
import pinoPretty from "pino-pretty";
import {
  firstValueFrom,
  from,
  mergeMap,
  Observable,
  reduce,
  of,
  BehaviorSubject,
  filter,
  interval,
  exhaustMap,
  take,
  EMPTY,
  Subject,
} from "rxjs";
import { ZswapSecretKeys } from "@midnightntwrk/ledger-v9";
import { UnshieldedAddress, MidnightBech32m } from "@midnightntwrk/wallet-sdk-address-format";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import { prepareAuthContext } from "../auth/authContext.js";
import { PostgresqlUserRepository } from "../auth/postgresql-user-repository.js";
import { defaultRoot } from "../composition-root.js";
import { loadConfig, ServerConfig } from "../config.js";
import { knexResource, runMigrations } from "../postgres.js";
import { prepareServer } from "../server.js";

process.on("uncaughtException", (err: Error) => {
  // eslint-disable-next-line no-console
  console.error("Uncaught exception", err);
  // Do some clean up
  process.exit(1);
});

const logger = pino({ level: "error" }, pinoPretty({ colorize: true }));

const DROP_AMOUNT_TNIGHT = "1000";

describe("Faucet Server", () => {
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
      address:
        "mn_shield-addr_undeployed1ultslmhufn32879kzanlsvmxvt493tk83y82hrwchggy5r93gpex5uajcx78sucyaghmgshlcn8c4xedxxgr4lejkjh5ztz0m47uk5q9uacj",
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
      const unshieldedAddressString = (await firstValueFrom(state$)).unshielded.address;

      return {
        requestTokens(address: WalletAddress): Promise<TokenResponse> {
          return address === receiver
            ? resolveDelayed<TokenResponse>(preparedResponse)
            : Promise.reject<TokenResponse>(new Error("Request from wrong address"));
        },
        dropAmount: "500",
        address: UnshieldedAddress.codec
          .encode(config.networkId, unshieldedAddressString)
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
      debug: false,
    });
    await runMigrations(knexInstance, logger);
  };

  const prepareData = async (config: ServerConfig) => {
    return pipe(
      knexResource(config.db, logger),
      Resource.mapPromise(async (knex) => {
        await knex("users").delete();
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

  const captchaToken = "XXXX.DUMMY.TOKEN.XXXX";

  /** Helper to POST a drip request to the public API */
  const postDrip = (faucetUrl: string, address: string, amount = DROP_AMOUNT_TNIGHT) =>
    fetch(`${faucetUrl}/drips`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Captcha-Token": captchaToken,
      },
      body: JSON.stringify(
        dripRequestCodec.encode({
          recipientAddress: address,
          amount: BigInt(amount),
        }),
      ),
    });

  /** Helper to GET drip status */
  const checkDripStatus =
    (faucetUrl: string) =>
    (dripId: string): Promise<DripResponse> =>
      fetch(`${faucetUrl}/drips/${dripId}`, {
        headers: {
          "Content-Type": "application/json",
        },
      })
        .then((res) => res.json())
        .then((response) => dripResponseCodec.decode(response))
        .then((result) =>
          either.getOrElseW((leftValue) => {
            throw leftValue;
          })(result),
        );

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** Poll a drip's status until it settles (CONFIRMED/FAILED), or give up with "TIMEOUT". */
  const waitForFinalStatus = async (
    checkStatus: (dripId: string) => Promise<DripResponse>,
    dripId: string,
    { attempts = 60, delayMs = 500 }: { attempts?: number; delayMs?: number } = {},
  ): Promise<string> => {
    const status = await checkStatus(dripId);
    if (status.status === "CONFIRMED" || status.status === "FAILED") {
      return status.status;
    }
    if (attempts <= 1) {
      return "TIMEOUT";
    }
    await sleep(delayMs);
    return waitForFinalStatus(checkStatus, dripId, { attempts: attempts - 1, delayMs });
  };

  /** Poll the rate_counts row for `address` until `count` reaches `target`; returns the last count seen. */
  const pollRateCount = async (
    knex: ReturnType<typeof knexLib>,
    address: string,
    target: number,
    { attempts = 60, delayMs = 100 }: { attempts?: number; delayMs?: number } = {},
  ): Promise<number> => {
    const row = await knex<{ address: string; count: number }>("rate_counts")
      .where({ address })
      .first();
    const count = Number(row?.count);
    if (count === target || attempts <= 1) {
      return count;
    }
    await sleep(delayMs);
    return pollRateCount(knex, address, target, { attempts: attempts - 1, delayMs });
  };

  /** Poll a task row until it reaches `target`; returns the last status seen. */
  const pollTaskStatus = async (
    knex: ReturnType<typeof knexLib>,
    id: string,
    target: string,
    { attempts = 100, delayMs = 50 }: { attempts?: number; delayMs?: number } = {},
  ): Promise<string | undefined> => {
    const row = await knex<{ id: string; status: string }>("tasks").where({ id }).first();
    if (row?.status === target || attempts <= 1) {
      return row?.status;
    }
    await sleep(delayMs);
    return pollTaskStatus(knex, id, target, { attempts: attempts - 1, delayMs });
  };

  /**
   * How many slots `address` has spent today. No row means none were ever
   * reserved, which reads as zero — reporting `NaN` instead would turn a missing
   * row into "expected NaN to be 0" and hide what actually went wrong.
   */
  const readRateCount = async (
    knex: ReturnType<typeof knexLib>,
    address: string,
  ): Promise<number> =>
    knex<{ address: string; count: number }>("rate_counts")
      .where({ address })
      .first()
      .then((row) => (row === undefined ? 0 : Number(row.count)));

  /**
   * Assert a slot count reaches `expected` **and stays there**.
   *
   * A single reading taken at a fixed moment cannot tell "refunded once" from
   * "about to be refunded again": the second refund of a double-refund lands in
   * the task manager's finalize tail, after the drip has already been reported as
   * settled. Re-reading once the tail has had time to run is what makes the
   * exactly-once claim testable.
   */
  const expectSettledRateCount = async (
    knex: ReturnType<typeof knexLib>,
    address: string,
    expected: number,
  ): Promise<void> => {
    expect(await pollRateCount(knex, address, expected)).toBe(expected);
    await sleep(500);
    expect(await readRateCount(knex, address)).toBe(expected);
  };

  /**
   * Drop tasks earlier tests left unfinished.
   *
   * Every test shares one database, and a test that deliberately hangs a dispense
   * leaves its task behind. A later test that needs its own drip *picked* would
   * otherwise wait for workers those leftovers are still holding.
   */
  const clearPendingTasks = (knex: ReturnType<typeof knexLib>) =>
    knex("tasks").whereIn("status", ["scheduled", "in_progress"]).delete();

  /** Age a picked task past the in-progress timeout so the real sweep strands it. */
  const strandTask = (knex: ReturnType<typeof knexLib>, id: string) =>
    knex("tasks")
      .where({ id })
      .update({ start_time: new Date(Date.now() - 10 * 60 * 1000) });

  /**
   * A handler the test releases by hand, so a drip can still be in flight while
   * the sweep runs against it.
   */
  const heldHandler = <T>(outcome: () => Promise<T>) => {
    const gate = new Subject<void>();
    const held = firstValueFrom(gate);
    return { release: () => gate.next(), handler: () => held.then(outcome) };
  };

  /**
   * A `Faucet` whose only interesting behaviour is `requestTokens` — everything
   * else is the inert boilerplate the server needs in order to boot.
   */
  const stubFaucet = (requestTokens: Faucet["requestTokens"]): Faucet => ({
    requestTokens,
    dropAmount: "500",
    address: getRandomBech32mAddress(),
    state$: getFaucetState(logger, fakeWallet()),
    syncErrors$: EMPTY,
    serializeWalletState: () => ({
      shielded: Promise.resolve(""),
      unshielded: Promise.resolve(""),
      dust: Promise.resolve(""),
    }),
  });

  /**
   * A wallet state the poll loop refuses to pick tasks from: no coins, so
   * `availableBalance` never clears the `2 × dropAmount` bar in the composition
   * root. Used to prove the timeout sweep still runs while picking is blocked.
   */
  const unpickableState = () =>
    new BehaviorSubject<FaucetState>(
      // Type cast required because: WalletState is a large SDK type and these tests
      // only populate the fields the faucet state calculation reads.
      calculateFaucetState({
        ...cachedState,
        unshielded: {
          ...cachedState.unshielded,
          totalCoins: [],
          availableCoins: [],
          balances: {},
          pendingCoins: [],
          progress: {
            highestTransactionId: 100n,
            appliedId: 100n,
            isConnected: true,
            isStrictlyComplete: () => true,
            isCompleteWithin: () => true,
          },
          serialize: (): string => {
            throw new Error("Function not implemented.");
          },
        },
      } as unknown as WalletState),
    );

  /** Run `body` against Postgres, always destroying the connection afterwards. */
  const withKnex = async <A>(
    body: (knex: ReturnType<typeof knexLib>) => Promise<A>,
  ): Promise<A> => {
    const knex = knexLib({ client: "pg", connection: config.db });
    try {
      return await body(knex);
    } finally {
      await knex.destroy();
    }
  };

  it("responds to request made using the client", () => {
    const receiver = getRandomBech32mAddress();
    const { preparedResponse, faucet } = prepareFakeFaucet(config, receiver);

    const client = FaucetClient({
      url: `http://${config.host}:${config.port}/api`,
      pollInterval: 100,
    });
    return pipe(
      defaultRoot(config, () => faucet),
      Resource.flatMap((root) => prepareServer(config, root)),
      Resource.use(() =>
        Task.lift(() => client.requestTokens(receiver, captchaToken, DROP_AMOUNT_TNIGHT)),
      ),
      Task.tap((result) => {
        expect(result.transactionHash).toBe(preparedResponse.transactionIdentifier);
      }),
      Task.unsafeRun,
    );
  });

  it("responds with decoding error in case of wrong structure of a request", () => {
    const failingFaucet: Faucet = {
      requestTokens(): Promise<TokenResponse> {
        return Promise.reject(new Error("Not expecting faucet call"));
      },
      dropAmount: "500",
      address: getRandomBech32mAddress(),
      // dummy state
      state$: getFaucetState(logger, fakeWallet()),
      syncErrors$: EMPTY,
      serializeWalletState: () => ({
        shielded: Promise.resolve(""),
        unshielded: Promise.resolve(""),
        dust: Promise.resolve(""),
      }),
    };
    return pipe(
      defaultRoot(config, () => Resource.of(failingFaucet)),
      Resource.flatMap((root) => prepareServer(config, root)),
      Resource.use(() =>
        Task.lift(() =>
          fetch(`http://${config.host}:${config.port}/api/drips`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Captcha-Token": captchaToken,
            },
            body: JSON.stringify({}),
          }).then((res) => res.json().then((body) => ({ response: res, responseBody: body }))),
        ),
      ),
      Task.tap((result) => {
        expect(result.responseBody).toMatchObject({
          error: expect.any(String),
        });
        expect(result.response.status).toBe(400);
      }),
      Task.unsafeRun,
    );
  });

  it("allows to repeat request after e.g. decoding error, so no rate limits are hit", () => {
    const failingFaucet: Faucet = {
      requestTokens(): Promise<TokenResponse> {
        return Promise.reject(new Error("Not expecting faucet call"));
      },
      dropAmount: "500",
      address: getRandomBech32mAddress(),
      // dummy state
      state$: getFaucetState(logger, fakeWallet()),
      syncErrors$: EMPTY,
      serializeWalletState: () => ({
        shielded: Promise.resolve(""),
        unshielded: Promise.resolve(""),
        dust: Promise.resolve(""),
      }),
    };
    return pipe(
      defaultRoot(config, () => Resource.of(failingFaucet)),
      Resource.flatMap((root) => prepareServer(config, root)),
      Resource.use(() =>
        Task.lift(async () => {
          await fetch(`http://${config.host}:${config.port}/api/drips`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Captcha-Token": captchaToken,
            },
            body: JSON.stringify({}),
          });
          return fetch(`http://${config.host}:${config.port}/api/drips`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Captcha-Token": captchaToken,
            },
            body: JSON.stringify({}),
          }).then((res) => res.json().then((body) => ({ response: res, responseBody: body })));
        }),
      ),
      Task.tap((result) => {
        expect(result.responseBody).toMatchObject({
          error: expect.any(String),
        });
        expect(result.response.status).toBe(400);
      }),
      Task.unsafeRun,
    );
  });

  // Regression for #595:
  // a *valid* request that registers but whose async dispense FAILS must not
  // consume the caller's daily allowance (the existing decoding-error test only
  // covers failures that happen before the task is registered).
  it("does not consume the daily rate limit when the dispense fails (#595)", () => {
    const receiver = getRandomBech32mAddress();
    // Registration succeeds, but the dispense task always rejects.
    const failingFaucet = stubFaucet(() =>
      Promise.reject(new Error("Transaction submission error")),
    );
    const limitedConfig = {
      ...config,
      rateLimiting: {
        ...config.rateLimiting,
        maxDailyRequests: 1,
      },
    };
    const faucetUrl = `http://${limitedConfig.host}:${limitedConfig.port}/api`;

    return pipe(
      defaultRoot(limitedConfig, () => Resource.of(failingFaucet)),
      Resource.flatMap((root) => prepareServer(limitedConfig, root)),
      Resource.use(() =>
        Task.lift(async () => {
          // Valid request: passes validation, gets registered, then the dispense fails.
          const first = await postDrip(faucetUrl, receiver);
          expect(first.status).toBe(200);
          const { dripId } = await first.json();

          // Wait until the dispense has actually failed.
          const finalStatus = await waitForFinalStatus(checkDripStatus(faucetUrl), dripId);
          expect(finalStatus).toBe("FAILED");

          // The failed dispense delivered nothing, so a retry must be allowed.
          const second = await postDrip(faucetUrl, receiver);
          return { response: second, responseBody: await second.json() };
        }),
      ),
      Task.tap((result) => {
        // A failed dispense must not burn the allowance (#595): retry is allowed.
        expect(result.response.status).toBe(200);
      }),
      Task.unsafeRun,
    );
  });

  // A refund path that works once is not enough: the requester whose drip keeps
  // failing is exactly the one who retries, and each attempt has to be given back.
  it("keeps refunding across repeated failures in the same day", () => {
    const receiver = getRandomBech32mAddress();
    const failingFaucet = stubFaucet(() =>
      Promise.reject(new Error("Transaction submission error")),
    );
    const limitedConfig = {
      ...config,
      rateLimiting: { ...config.rateLimiting, maxDailyRequests: 1 },
    };
    const faucetUrl = `http://${limitedConfig.host}:${limitedConfig.port}/api`;

    const failOnce = async () => {
      const res = await postDrip(faucetUrl, receiver);
      expect(res.status).toBe(200);
      const { dripId } = await res.json();
      expect(await waitForFinalStatus(checkDripStatus(faucetUrl), dripId)).toBe("FAILED");
    };

    return pipe(
      defaultRoot(limitedConfig, () => Resource.of(failingFaucet)),
      Resource.flatMap((root) => prepareServer(limitedConfig, root)),
      Resource.use(() =>
        Task.lift(() =>
          withKnex(async (knex) => {
            await failOnce();
            await failOnce();

            await expectSettledRateCount(knex, receiver, 0);
            expect((await postDrip(faucetUrl, receiver)).status).toBe(200);
          }),
        ),
      ),
      Task.unsafeRun,
    );
  });

  // Regression for #595 (timeout/restart path): a task left `in_progress` and
  // failed by the bulk timeout sweep — not by executeTask — must still refund
  // the slot it reserved. Reproduces the most common trigger (a restart mid-drip).
  it("refunds the daily rate limit when a stuck task is failed by the timeout sweep (#595)", () => {
    const receiver = getRandomBech32mAddress();
    // A faucet that reports fully-synced so the poll loop actually runs the sweep.
    const failingFaucet = stubFaucet(() => Promise.reject(new Error("unused")));

    return pipe(
      defaultRoot(config, () => Resource.of(failingFaucet)),
      Resource.flatMap((root) => prepareServer(config, root)),
      Resource.use(() =>
        Task.lift(() =>
          withKnex(async (knex) => {
            // A slot reserved today, as registration would.
            await knex("rate_counts").insert({ address: receiver, count: 1 });
            // A task stuck in_progress past the 5-minute timeout (e.g. a restart
            // orphaned it) — the sweep will fail it, not executeTask.
            await knex("tasks").insert({
              id: nodeCrypto.randomUUID(),
              address: receiver,
              status: "in_progress",
              start_time: new Date(Date.now() - 10 * 60 * 1000),
              created_at: new Date(),
              amount: null,
            });

            // Poll ticks (pollTime=1ms) run failTimedOutTasks, which now refunds.
            return pollRateCount(knex, receiver, 0);
          }),
        ),
      ),
      Task.tap((count) => {
        expect(count).toBe(0);
      }),
      Task.unsafeRun,
    );
  });

  /** Seed a slot reserved today plus the orphaned task a restart mid-drip leaves. */
  const seedStrandedDrip = async (knex: ReturnType<typeof knexLib>, address: string) => {
    await knex("rate_counts").insert({
      address,
      count: 1,
      // Anchored to the start of today, so the refund's window check compares two
      // dates from the same day however close to midnight the suite runs.
      updated_at: DateTime.now().startOf("day").toJSDate(),
    });
    await knex("tasks").insert({
      id: nodeCrypto.randomUUID(),
      address,
      status: "in_progress",
      start_time: new Date(Date.now() - 10 * 60 * 1000),
      created_at: new Date(),
      amount: null,
    });
  };

  // The refund is only worth anything if the requester can then use it, which is
  // one more step than reading the counter back to zero.
  it("lets a requester retry the same day once the sweep refunds their stranded drip", () => {
    const receiver = getRandomBech32mAddress();
    const limitedConfig = {
      ...config,
      rateLimiting: { ...config.rateLimiting, maxDailyRequests: 1 },
    };
    const faucetUrl = `http://${limitedConfig.host}:${limitedConfig.port}/api`;
    const workingFaucet = stubFaucet(() =>
      Promise.resolve({
        transactionIdentifier: nodeCrypto.randomBytes(32).toString("hex"),
        timeToNextRequest: Duration.fromMillis(0),
      }),
    );

    return pipe(
      defaultRoot(limitedConfig, () => Resource.of(workingFaucet)),
      Resource.flatMap((root) => prepareServer(limitedConfig, root)),
      Resource.use(() =>
        Task.lift(() =>
          withKnex(async (knex) => {
            await seedStrandedDrip(knex, receiver);
            expect(await pollRateCount(knex, receiver, 0)).toBe(0);

            const retry = await postDrip(faucetUrl, receiver);
            expect(retry.status).toBe(200);
            const { dripId } = await retry.json();
            expect(await waitForFinalStatus(checkDripStatus(faucetUrl), dripId)).toBe("CONFIRMED");
          }),
        ),
      ),
      Task.unsafeRun,
    );
  });

  // The counter's `updated_at` is the day the window is anchored to. Moving it
  // while refunding would drag the window forward off the back of a failure,
  // which for a requester near midnight silently postpones their reset.
  it("does not move the daily window when it refunds a stranded slot", () => {
    const receiver = getRandomBech32mAddress();
    const idleFaucet = stubFaucet(() => Promise.reject(new Error("unused")));

    return pipe(
      defaultRoot(config, () => Resource.of(idleFaucet)),
      Resource.flatMap((root) => prepareServer(config, root)),
      Resource.use(() =>
        Task.lift(() =>
          withKnex(async (knex) => {
            await seedStrandedDrip(knex, receiver);
            const before = await knex<{ address: string; updated_at: Date }>("rate_counts")
              .where({ address: receiver })
              .first();

            expect(await pollRateCount(knex, receiver, 0)).toBe(0);

            const after = await knex<{ address: string; updated_at: Date }>("rate_counts")
              .where({ address: receiver })
              .first();
            expect(after?.updated_at.getTime()).toBe(before?.updated_at.getTime());
          }),
        ),
      ),
      Task.unsafeRun,
    );
  });

  // Regression for #595: registerTask dedupes concurrent/duplicate requests to a
  // single task, so the rate-limit slot must be reserved once (at task creation),
  // not once per POST — otherwise a UI double-submit burns N slots for one drip.
  it("does not consume extra rate-limit slots for deduped duplicate requests (#595)", () => {
    const receiver = getRandomBech32mAddress();
    // A handler that never resolves keeps the task in_progress, so repeat POSTs
    // hit registerTask's dedup path deterministically.
    const hangingFaucet = stubFaucet(() => new Promise<TokenResponse>(() => {}));
    const faucetUrl = `http://${config.host}:${config.port}/api`;

    return pipe(
      defaultRoot(config, () => Resource.of(hangingFaucet)),
      Resource.flatMap((root) => prepareServer(config, root)),
      Resource.use(() =>
        Task.lift(() =>
          withKnex(async (knex) => {
            // Three duplicate submissions for the same address (a UI double-submit).
            for (const _ of Array.from({ length: 3 })) {
              const res = await postDrip(faucetUrl, receiver);
              expect(res.status).toBe(200);
            }
            const row = await knex<{ address: string; count: number }>("rate_counts")
              .where({ address: receiver })
              .first();
            return Number(row?.count);
          }),
        ),
      ),
      Task.tap((count) => {
        // Deduped duplicates map to one task, so only one slot is reserved.
        expect(count).toBe(1);
      }),
      Task.unsafeRun,
    );
  });

  /**
   * The poll loop runs the sweep and the dispense through the same `mergeMap`, so
   * with the default concurrency of one an in-flight drip blocks the sweep and the
   * two can never overlap in a single instance. Raising it is what lets the real
   * sweep strand a drip that is still running — the same overlap a second server
   * instance produces in production.
   */
  const racingConfig = () => ({
    ...config,
    tasks: { ...config.tasks, maxConcurrentTasks: 2 },
  });

  /**
   * Regression for #617, fixed in #619. `registerTask` reads for an active task and
   * then reserves and creates, with nothing holding the address in between.
   * Duplicates arriving within that window — a double-clicked button, a client
   * retry — all read "nothing in flight", so each used to reserve a slot *and*
   * schedule its own dispense: the requester lost several of their daily requests
   * and received several drips.
   *
   * Reserving on the create path only, which the sequential duplicate coverage above
   * pins, fixes the double-submit arriving as two round trips. It cannot fix the one
   * that arrives at once — that takes the `tasks_active_address_unique` index, which
   * refuses the second insert so the loser can hand its slot back.
   *
   * This passing does not on its own prove the race was *exercised*: whether the
   * three requests truly interleave depends on which wins a fresh pool connection
   * (`min: 0`, so none are warm). The repository suite pins the constraint directly
   * and does not depend on that timing.
   */
  it("does not consume extra slots for simultaneous duplicate requests", () => {
    const receiver = getRandomBech32mAddress();
    const hangingFaucet = stubFaucet(() => new Promise<TokenResponse>(() => {}));
    const faucetUrl = `http://${config.host}:${config.port}/api`;

    return pipe(
      defaultRoot(config, () => Resource.of(hangingFaucet)),
      Resource.flatMap((root) => prepareServer(config, root)),
      Resource.use(() =>
        Task.lift(() =>
          withKnex(async (knex) => {
            const responses = await Promise.all(
              Array.from({ length: 3 }, () => postDrip(faucetUrl, receiver)),
            );
            responses.forEach((res) => expect(res.status).toBe(200));

            return readRateCount(knex, receiver);
          }),
        ),
      ),
      Task.tap((count) => {
        expect(count).toBe(1);
      }),
      Task.unsafeRun,
    );
  });

  // Regression for #595 (double-refund): a slow drip can be failed *and refunded*
  // by the timeout sweep while its dispense is still in flight. When the dispense
  // then also reports failure, executeTask must NOT refund the slot a second time
  // — a second refund decrements a *different*, successful request's slot, handing
  // the address an extra daily allowance. executeTask now finalizes only while the
  // task is still `in_progress`, so an already-swept task is skipped here.
  it("refunds a failed drip's slot only once when the sweep strands it mid-dispense", () => {
    const receiver = getRandomBech32mAddress();
    const racing = racingConfig();
    const faucetUrl = `http://${racing.host}:${racing.port}/api`;
    // The drip hangs until the sweep has had its turn, then fails.
    const { release, handler } = heldHandler(() =>
      Promise.reject<TokenResponse>(new Error("Transaction submission error")),
    );

    return withKnex(async (knex) => {
      // Before the server exists, not once it is polling: a leftover picked in
      // between would be handed the held dispense and never release its worker.
      await clearPendingTasks(knex);

      return pipe(
        defaultRoot(racing, () => Resource.of(stubFaucet(handler))),
        Resource.flatMap((root) => prepareServer(racing, root)),
        Resource.use(() =>
          Task.lift(async () => {
            // Registration reserves one slot (count = 1) and schedules the task.
            const res = await postDrip(faucetUrl, receiver);
            expect(res.status).toBe(200);
            const { dripId } = await res.json();

            expect(await pollTaskStatus(knex, dripId, "in_progress")).toBe("in_progress");
            // Age the picked task so the *real* `failTimedOutTasks` strands it
            // while its dispense is still running.
            await strandTask(knex, dripId);
            expect(await pollRateCount(knex, receiver, 0)).toBe(0);

            // Stand in for a later, successful request from the same address, so a
            // second refund shows up as that slot being stolen rather than being
            // absorbed by the zero floor.
            await knex("rate_counts").where({ address: receiver }).increment("count", 1);

            release();
            expect(await waitForFinalStatus(checkDripStatus(faucetUrl), dripId)).toBe("FAILED");
            // 1 (later request) with only the sweep's refund applied. A double
            // refund drops this to 0.
            await expectSettledRateCount(knex, receiver, 1);
          }),
        ),
        Task.unsafeRun,
      );
    });
  });

  // Regression for #595 (over-refund on a late success): the sweep can fail *and
  // refund* a slow drip whose dispense then succeeds anyway. Tokens were delivered,
  // so the slot must be re-consumed and the task recorded as a success — otherwise
  // the address keeps its full daily allowance *and* got the tokens.
  it("re-consumes the slot when a drip succeeds after the sweep refunded it", () => {
    const receiver = getRandomBech32mAddress();
    const racing = racingConfig();
    const faucetUrl = `http://${racing.host}:${racing.port}/api`;
    const { release, handler } = heldHandler(() =>
      Promise.resolve<TokenResponse>({
        transactionIdentifier: nodeCrypto.randomBytes(32).toString("hex"),
        timeToNextRequest: Duration.fromMillis(0),
      }),
    );

    return withKnex(async (knex) => {
      await clearPendingTasks(knex);

      return pipe(
        defaultRoot(racing, () => Resource.of(stubFaucet(handler))),
        Resource.flatMap((root) => prepareServer(racing, root)),
        Resource.use(() =>
          Task.lift(async () => {
            const res = await postDrip(faucetUrl, receiver);
            expect(res.status).toBe(200);
            const { dripId } = await res.json();

            expect(await pollTaskStatus(knex, dripId, "in_progress")).toBe("in_progress");
            await strandTask(knex, dripId);
            expect(await pollRateCount(knex, receiver, 0)).toBe(0);

            // Only now do the tokens actually go out.
            release();

            // The drip delivered, so the swept `failure` row has to be reclaimed:
            // polling for `success` specifically, because the sweep already wrote a
            // settled status that a first-settled-status poll would report instead.
            expect(await pollTaskStatus(knex, dripId, "success")).toBe("success");
            expect((await checkDripStatus(faucetUrl)(dripId)).status).toBe("CONFIRMED");
            // 1 (registration) − 1 (sweep refund) + 1 (reclaim). Without the
            // reclaim this stays 0 — tokens delivered and the allowance intact.
            await expectSettledRateCount(knex, receiver, 1);
          }),
        ),
        Task.unsafeRun,
      );
    });
  });

  // Regression for #595: the sweep must run even when the wallet cannot pick tasks.
  // An unsynced or underfunded wallet is precisely when drips strand, so gating the
  // refund behind `canPickTasks` left every reserved slot burned for the whole
  // outage — and the stranded-`scheduled` sweep could never fire at all, since its
  // own trigger is the wallet being unpickable.
  it("refunds a stranded slot even while the wallet cannot pick tasks (#595)", () => {
    const receiver = getRandomBech32mAddress();
    const brokeFaucet: Faucet = {
      ...stubFaucet(() => Promise.reject(new Error("unused"))),
      state$: unpickableState(),
    };

    return pipe(
      defaultRoot(config, () => Resource.of(brokeFaucet)),
      Resource.flatMap((root) => prepareServer(config, root)),
      Resource.use(() =>
        Task.lift(() =>
          withKnex(async (knex) => {
            // A slot reserved today, as registration would.
            await knex("rate_counts").insert({ address: receiver, count: 1 });
            // Orphaned in_progress past the timeout, e.g. a restart mid-drip.
            await knex("tasks").insert({
              id: nodeCrypto.randomUUID(),
              address: receiver,
              status: "in_progress",
              start_time: new Date(Date.now() - 10 * 60 * 1000),
              created_at: new Date(),
              amount: null,
            });

            return pollRateCount(knex, receiver, 0);
          }),
        ),
      ),
      Task.tap((count) => {
        // Pre-fix the sweep sat behind the `canPickTasks` filter, so this stayed 1.
        expect(count).toBe(0);
      }),
      Task.unsafeRun,
    );
  });

  // Regression for #622: an address pinned by a stranded `scheduled` task. The sweep
  // only ever looked at `in_progress`, on the reasoning that `pick` would eventually
  // run anything queued — but while no wallet can pick, nothing does, and since
  // migration 009 that one unfinished row is what stops the address requesting
  // again. The requester was left holding a burned slot on a task that would never
  // run, polling `PENDING` forever.
  it("fails and refunds a scheduled task no wallet ever picked up (#622)", () => {
    const receiver = getRandomBech32mAddress();
    const strandedId = nodeCrypto.randomUUID();
    // No wallet able to pick, so the queued task genuinely never advances.
    const brokeFaucet: Faucet = {
      ...stubFaucet(() => Promise.reject(new Error("unused"))),
      state$: unpickableState(),
    };
    const faucetUrl = `http://${config.host}:${config.port}/api`;

    return pipe(
      defaultRoot(config, () => Resource.of(brokeFaucet)),
      Resource.flatMap((root) => prepareServer(config, root)),
      Resource.use(() =>
        Task.lift(() =>
          withKnex(async (knex) => {
            // The scheduled arm only fires when nothing has been picked recently,
            // and this file shares one database, so drips dispensed by earlier tests
            // would read as a live poller and hold the gate shut. Clearing them is
            // what makes "no wallet ever picked up" true of the whole table, which is
            // the state this test is about.
            await knex("tasks").whereNot({ address: receiver }).delete();
            // A slot reserved today, as registration would.
            await knex("rate_counts").insert({ address: receiver, count: 1 });
            // Queued well past the scheduled timeout and never picked.
            await knex("tasks").insert({
              id: strandedId,
              address: receiver,
              status: "scheduled",
              created_at: new Date(Date.now() - 90 * 60 * 1000),
              amount: null,
            });

            const count = await pollRateCount(knex, receiver, 0);
            const swept = await knex<{ id: string; status: string }>("tasks")
              .where({ id: strandedId })
              .first();
            // The refund is only half the fix: the pin has to lift too, so a retry
            // must produce a *new* task rather than dedupe onto the dead one.
            const retry = await postDrip(faucetUrl, receiver);
            const { dripId } = await retry.json();

            return { count, status: swept?.status, retryStatus: retry.status, dripId };
          }),
        ),
      ),
      Task.tap(({ count, status, retryStatus, dripId }) => {
        expect(status).toBe("failure");
        expect(count).toBe(0);
        expect(retryStatus).toBe(200);
        expect(dripId).not.toBe(strandedId);
      }),
      Task.unsafeRun,
    );
  });

  // Regression for #622: `start_time` is nullable, and `NULL < timestamp` is NULL, so
  // comparing the column directly excluded exactly the rows most likely to be stuck —
  // an `in_progress` task that got there without going through `pick`.
  it("fails an in-progress task whose start_time is null (#622)", () => {
    const receiver = getRandomBech32mAddress();
    const failingFaucet = stubFaucet(() => Promise.reject(new Error("unused")));

    return pipe(
      defaultRoot(config, () => Resource.of(failingFaucet)),
      Resource.flatMap((root) => prepareServer(config, root)),
      Resource.use(() =>
        Task.lift(() =>
          withKnex(async (knex) => {
            await knex("rate_counts").insert({ address: receiver, count: 1 });
            await knex("tasks").insert({
              id: nodeCrypto.randomUUID(),
              address: receiver,
              status: "in_progress",
              start_time: null,
              created_at: new Date(Date.now() - 10 * 60 * 1000),
              amount: null,
            });

            return pollRateCount(knex, receiver, 0);
          }),
        ),
      ),
      Task.tap((count) => {
        expect(count).toBe(0);
      }),
      Task.unsafeRun,
    );
  });

  it("responds with rate limit error once exhausted", () => {
    const receiver = getRandomBech32mAddress();
    const { preparedResponse, faucet } = prepareFakeFaucet(config, receiver);
    const newConfig = {
      ...config,
      rateLimiting: {
        ...config.rateLimiting,
        maxDailyRequests: 1,
      },
    };
    const client = FaucetClient({
      url: `http://${newConfig.host}:${newConfig.port}/api`,
      pollInterval: 100,
    });
    return pipe(
      defaultRoot(newConfig, () => faucet),
      Resource.flatMap((root) => prepareServer(newConfig, root)),
      Resource.use(() =>
        Task.lift(async () => {
          const result = await client.requestTokens(receiver, captchaToken, DROP_AMOUNT_TNIGHT);
          expect(result.transactionHash).toBe(preparedResponse.transactionIdentifier);
          await expect(
            client.requestTokens(receiver, captchaToken, DROP_AMOUNT_TNIGHT),
          ).rejects.toThrow(
            /You can't resubmit right now, next attempt is allowed at .*UTC.*in 24 hours\./i,
          );
        }),
      ),
      Task.unsafeRun,
    );
  });

  it("allows rate limit to reset on a new day", () => {
    const receiver = getRandomBech32mAddress();
    const { preparedResponse, faucet } = prepareFakeFaucet(config, receiver);
    const newConfig = {
      ...config,
      rateLimiting: {
        ...config.rateLimiting,
        maxDailyRequests: 1,
      },
    };
    const client = FaucetClient({
      url: `http://${newConfig.host}:${newConfig.port}/api`,
      pollInterval: 100,
    });
    return pipe(
      defaultRoot(newConfig, () => faucet),
      Resource.flatMap((root) => prepareServer(newConfig, root)),
      Resource.use(() =>
        Task.lift(async () => {
          let result = await client.requestTokens(receiver, captchaToken, DROP_AMOUNT_TNIGHT);
          expect(result.transactionHash).toBe(preparedResponse.transactionIdentifier);
          await expect(
            client.requestTokens(receiver, captchaToken, DROP_AMOUNT_TNIGHT),
          ).rejects.toThrow(
            /You can't resubmit right now, next attempt is allowed at .*UTC.*in 24 hours\./i,
          );
          const current = Settings.now;
          const tomorrow = DateTime.now().plus({ days: 1 });
          try {
            Settings.now = () => tomorrow.valueOf();
            result = await client.requestTokens(receiver, captchaToken, DROP_AMOUNT_TNIGHT);
            // We'd expect the the transaction ID to differ here, but the fake faucet is returning a
            // prepared response. The test simply requires a response to ensure that the rate limit is now
            // no longer being triggered.
            expect(result.transactionHash).toBe(preparedResponse.transactionIdentifier);
          } finally {
            Settings.now = current;
          }
        }),
      ),
      Task.unsafeRun,
    );
  });

  it("responds with error in case of error coming from faucet", () => {
    const receiver = getRandomBech32mAddress();
    const failingFaucet: Faucet = {
      requestTokens(): Promise<TokenResponse> {
        return Promise.reject(new Error("Faucet fail"));
      },
      dropAmount: "500",
      address: getRandomBech32mAddress(),
      // dummy state
      state$: getFaucetState(logger, fakeWallet()),
      syncErrors$: EMPTY,
      serializeWalletState: () => ({
        shielded: Promise.resolve(""),
        unshielded: Promise.resolve(""),
        dust: Promise.resolve(""),
      }),
    };
    const client = FaucetClient({
      url: `http://${config.host}:${config.port}/api`,
      pollInterval: 100,
    });
    return pipe(
      defaultRoot(config, () => Resource.of(failingFaucet)),
      Resource.flatMap((root) => prepareServer(config, root)),
      Resource.use(() =>
        Task.lift(() => client.requestTokens(receiver, captchaToken, DROP_AMOUNT_TNIGHT)),
      ),
      Task.attempt,
      Task.map((result) => {
        return pipe(
          result,
          either.swap,
          either.getOrElseW(() => {
            throw new Error("Not expected response");
          }),
        );
      }),
      Task.tap((error) => {
        const err = error as ClientError;
        expect(err).toBeInstanceOf(ClientError);
        expect(err.type).toBe("error");
        expect(err.message).toBe("Faucet fail");
      }),
      Task.unsafeRun,
    );
  });

  it("serves configured directory at /", () => {
    const listFilesToCheck: Task<string[]> = Task.lift(() =>
      fs.readdir(`${config.uiPath}/assets`, { recursive: true }),
    );

    const gatherResults = (
      in$: Observable<{ filePath: string; contents: Buffer }>,
    ): Promise<Record<string, string>> =>
      pipe(
        in$,
        reduce((acc: Record<string, string>, current) => {
          const hash = nodeCrypto
            .createHash("sha256")
            .update(current.contents)
            .digest()
            .toString("hex");

          return {
            ...acc,
            [current.filePath]: hash,
          };
        }, {}),
        (x) => firstValueFrom(x),
      );

    const readFiles = (filesToRead: string[]): Task<Record<string, string>> =>
      Task.lift(() =>
        pipe(
          from(filesToRead),
          mergeMap(async (filePath) => {
            const contents = await fs.readFile(path.resolve(`${config.uiPath}/assets`, filePath));
            return { filePath, contents };
          }),
          gatherResults,
        ),
      );

    const fetchFiles = (files: string[]): Task<Record<string, string>> =>
      Task.lift(() => {
        return pipe(
          from(files),
          mergeMap((filePath) => {
            return fetch(`http://${config.host}:${config.port}/${filePath}`)
              .then((response) => response.arrayBuffer())
              .then((contents) => ({ filePath, contents: Buffer.from(contents) }));
          }),
          gatherResults,
        );
      });

    // We loosen the check to exclude the hash generated,  "index-CHg60Ia2.css": "406dfdf0eb17cf8d9c142d0cd9f4f6d2727ecccad492dc67eab6a96d7f7f77f0",
    // and only include the file name, because every time we run the tests new hashes get generated with vitest.
    // Any small change in the build pipeline (dependencies, order of assets, timestamps ...) can alter the hash, so tests that check exact hashes will almost always fail across builds.
    return pipe(
      defaultRoot(config, () => prepareFakeFaucet(config, getRandomBech32mAddress()).faucet),
      Resource.flatMap((root) => prepareServer(config, root)),
      Resource.use(() =>
        pipe(
          listFilesToCheck,
          Task.flatMap((fileList) => pipe(readFiles(fileList), Task.zip(fetchFiles(fileList)))),
        ),
      ),
      Task.tap(([_, fetchResult]) => {
        const fileNames = Object.keys(fetchResult);
        // Check that we have the expected types of files, but don't check exact hashed names
        // since they change with every build
        expect(fileNames.some((name) => name.startsWith("index-") && name.endsWith(".css"))).toBe(
          true,
        );
        expect(fileNames.some((name) => name.startsWith("index-") && name.endsWith(".js"))).toBe(
          true,
        );
        expect(
          fileNames.some((name) => name.includes("logo-render") && name.endsWith(".png")),
        ).toBe(true);
        expect(
          fileNames.some((name) => name.includes("midnight-logo") && name.endsWith(".png")),
        ).toBe(true);
        expect(
          fileNames.some(
            (name) => name.includes("midnight_ledger_wasm_v9_bg") && name.endsWith(".wasm"),
          ),
        ).toBe(true);

        expect(fileNames.length).toBeGreaterThanOrEqual(5);
      }),
      Task.unsafeRun,
    );
  });

  describe("polling", () => {
    it("immediately returns registered drip id to be polled for status separately", () => {
      const receiver = getRandomBech32mAddress();
      const { preparedResponse, faucet } = prepareFakeFaucet(config, receiver, 1000_000);

      const faucetUrl = `http://${config.host}:${config.port}/api`;
      return pipe(
        defaultRoot(config, () => faucet),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          pipe(
            Task.lift((): Promise<unknown> => {
              return postDrip(faucetUrl, receiver).then((res) => res.json());
            }),
            Task.timeout(1_000),
          ),
        ),
        Task.tap((result: unknown) => {
          const drip = result as DripResponse;
          expect(drip.dripId).toBeDefined();
          expect(drip.status).toBe("PENDING");
          expect(drip.dripId).not.toEqual(preparedResponse.transactionIdentifier);
        }),
        Task.unsafeRun,
      );
    });

    it("returns saved response upon task completion", () => {
      const completedDelay = 3_000 + Math.random() * 2_000;
      const inProgressDelay = 2_500;
      const receiver = getRandomBech32mAddress();
      const { preparedResponse, faucet } = prepareFakeFaucet(config, receiver, completedDelay);

      const faucetUrl = `http://${config.host}:${config.port}/api`;
      const statusChecker = checkDripStatus(faucetUrl);
      return pipe(
        defaultRoot(config, () => faucet),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          pipe(
            Task.lift(() => {
              return postDrip(faucetUrl, receiver)
                .then((res) => res.json())
                .then((drip: DripResponse) => ({ dripId: drip.dripId }));
            }),
            Task.flatMapPromise(async ({ dripId }) => {
              const immediateResult = await statusChecker(dripId);
              const inProgressResult = await new Promise((resolve) => {
                setTimeout(resolve, inProgressDelay);
              }).then(() => statusChecker(dripId));
              const finalResult = await new Promise((resolve) => {
                setTimeout(resolve, completedDelay);
              }).then(() => statusChecker(dripId));

              return { immediateResult, inProgressResult, finalResult };
            }),
          ),
        ),
        Task.tap(({ finalResult }) => {
          expect(finalResult.status).toBe("CONFIRMED");
          expect(finalResult.transactionHash).toBe(preparedResponse.transactionIdentifier);
        }),
        Task.unsafeRun,
      );
    });

    it("returns captured error upon task failure", () => {
      const taskDelay = 1_000;
      const recheckDelay = 4_000 + Math.random() * 2_000;
      const receiver = getRandomBech32mAddress();
      const failingFaucet: Faucet = {
        requestTokens: async (): Promise<TokenResponse> => {
          await new Promise((resolve) => {
            setTimeout(resolve, taskDelay);
          });
          throw new Error("Let faucet fall");
        },
        dropAmount: "500",
        address: getRandomBech32mAddress(),
        state$: getFaucetState(logger, fakeWallet()),
        syncErrors$: EMPTY,
        serializeWalletState: () => ({
          shielded: Promise.resolve(""),
          unshielded: Promise.resolve(""),
          dust: Promise.resolve(""),
        }),
      };

      const faucetUrl = `http://${config.host}:${config.port}/api`;
      const statusChecker = checkDripStatus(faucetUrl);
      return pipe(
        defaultRoot(config, () => Resource.of(failingFaucet)),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          pipe(
            Task.lift(() => {
              return postDrip(faucetUrl, receiver)
                .then((res) => res.json())
                .then((drip: DripResponse) => ({ dripId: drip.dripId }));
            }),
            Task.flatMapPromise(async ({ dripId }) => {
              const immediateResult = await statusChecker(dripId);
              const finalResult = await new Promise((resolve) => {
                setTimeout(resolve, recheckDelay);
              }).then(() => statusChecker(dripId));

              return { immediateResult, finalResult };
            }),
          ),
        ),
        Task.tap(({ immediateResult, finalResult }) => {
          expect(["PENDING"]).toContain(immediateResult.status);
          expect(finalResult.status).toBe("FAILED");
          expect(finalResult.error).toBe("Let faucet fall");
        }),
        Task.unsafeRun,
      );
    });

    // The wallet SDK wraps the real node error in a generic SubmissionError
    // ("Transaction submission error") and puts the reason in `cause`. The
    // reported error must include that cause, not just the generic wrapper,
    // so failures are diagnosable instead of opaque.
    it("surfaces the underlying cause when a dispense fails", () => {
      const recheckDelay = 4_000 + Math.random() * 2_000;
      const receiver = getRandomBech32mAddress();
      // A plain object as the `cause`, not an Error: wrappers report the node's
      // reason inconsistently, and this shape used to flatten to nothing, leaving
      // only the useless outer "Transaction submission error" (#595).
      const failingFaucet = stubFaucet(() =>
        Promise.reject(
          new Error("Transaction submission error", {
            cause: { message: "node rejected: insufficient balance" },
          }),
        ),
      );

      const faucetUrl = `http://${config.host}:${config.port}/api`;
      const statusChecker = checkDripStatus(faucetUrl);
      return pipe(
        defaultRoot(config, () => Resource.of(failingFaucet)),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          pipe(
            Task.lift(() =>
              postDrip(faucetUrl, receiver)
                .then((res) => res.json())
                .then((drip: DripResponse) => ({ dripId: drip.dripId })),
            ),
            Task.flatMapPromise(async ({ dripId }) => {
              return new Promise((resolve) => setTimeout(resolve, recheckDelay)).then(() =>
                statusChecker(dripId),
              );
            }),
          ),
        ),
        Task.tap((finalResult) => {
          expect(finalResult.status).toBe("FAILED");
          expect(finalResult.error).toContain("node rejected: insufficient balance");
        }),
        Task.unsafeRun,
      );
    });

    it("picks requests only when it has enough available coins to cover it", () => {
      const receiver = getRandomBech32mAddress();

      const state$ = new BehaviorSubject<FaucetState>(
        calculateFaucetState({
          ...cachedState,
          unshielded: {
            ...cachedState.unshielded,
            totalCoins: [
              {
                utxo: {
                  value: 5n,
                  owner: "",
                  type: "",
                  intentHash: "",
                  outputNo: 0,
                },
                meta: { ctime: new Date(), registeredForDustGeneration: false },
              },
              {
                utxo: {
                  value: 5n,
                  owner: "",
                  type: "",
                  intentHash: "",
                  outputNo: 0,
                },
                meta: { ctime: new Date(), registeredForDustGeneration: false },
              },
            ],
            availableCoins: [
              {
                utxo: {
                  value: 5n,
                  owner: "",
                  type: "",
                  intentHash: "",
                  outputNo: 0,
                },
                meta: { ctime: new Date(), registeredForDustGeneration: false },
              },
              {
                utxo: {
                  value: 5n,
                  owner: "",
                  type: "",
                  intentHash: "",
                  outputNo: 0,
                },
                meta: { ctime: new Date(), registeredForDustGeneration: false },
              },
            ],
            balances: {},
            pendingCoins: [],
            progress: {
              highestTransactionId: 100n,
              appliedId: 100n,
              isConnected: true,
              isStrictlyComplete: () => true,
              isCompleteWithin: () => true,
            },
            serialize: function (): string {
              throw new Error("Function not implemented.");
            },
          },
        } as unknown as WalletState),
      );

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

      const faucetUrl = `http://${config.host}:${config.port}/api`;
      const statusChecker = checkDripStatus(faucetUrl);
      return pipe(
        defaultRoot(
          {
            ...config,
            tasks: {
              ...config.tasks,
              pollTime: 1000,
            },
          },
          () => Resource.of(mockFaucet),
        ),
        Resource.flatMap((root) => prepareServer(config, root)),
        Resource.use(() =>
          pipe(
            Task.lift(() => {
              return postDrip(faucetUrl, receiver)
                .then((res) => res.json())
                .then((drip: DripResponse) => ({ dripId: drip.dripId }));
            }),
            Task.flatMapPromise(async ({ dripId }) => {
              const immediateTaskStatus = await statusChecker(dripId);

              // update state with enough available coins to pick task
              const calculatedNextState = calculateFaucetState(cachedState);
              state$.next(calculatedNextState);

              const postStateUpdateTaskStatus = await firstValueFrom(
                interval(1000).pipe(
                  exhaustMap(() => from(statusChecker(dripId))),
                  filter((requestStatus) => requestStatus.status === "CONFIRMED"),
                  take(1),
                ),
              );

              return { immediateTaskStatus, postStateUpdateTaskStatus };
            }),
          ),
        ),
        Task.tap(({ immediateTaskStatus, postStateUpdateTaskStatus }) => {
          expect(immediateTaskStatus.status).toEqual("PENDING");
          expect(postStateUpdateTaskStatus.status).toEqual("CONFIRMED");
        }),
        Task.unsafeRun,
      );
    });
  });
});
