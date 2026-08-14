/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { checkIndexer, checkProofServer, checkNode } from "@midnight-ntwrk/faucet";
import {
  Faucet,
  tokenResponseCodec,
  TokenResponseOutput,
} from "@midnight-ntwrk/faucet-internal-api";
import { pipe, Resource } from "@midnight-ntwrk/faucet-utils";
import pino from "pino";
import * as rx from "rxjs";
import { register, type Registry } from "prom-client";
import { AuthContext, prepareAuthContext } from "./auth/authContext.js";
import { PostgresqlUserRepository } from "./auth/postgresql-user-repository.js";
import { ServerConfig } from "./config.js";
import { prepareFaucet } from "./faucet.js";
import { HealthService } from "./health.js";
import { createLogger } from "./logging.js";
import { checkDb, knexResource } from "./postgres.js";
import { TaskManager } from "./TaskManager.js";
import { PostgresqlStateSnapshotsRepository } from "./state-persistence/state-persistence-repository.js";
import { getState } from "./state-persistence/get-and-deserialize-state.js";
import { PostgresqlTaskRepository } from "./tasks/task-repository.js";
import { PostgresqlRateCountRepository } from "./rate-counts/rate-counts-repository.js";
import { createSyncStuckDetector, type SyncStuckDetector } from "./sync-stuck-detector.js";

export type StateContext = {
  stateSnapshots: PostgresqlStateSnapshotsRepository;
  taskRepository: PostgresqlTaskRepository;
  rateCountRepository: PostgresqlRateCountRepository;
};

export type CompositionRoot = {
  faucet: Faucet;
  taskManager: TaskManager<TokenResponseOutput>;
  stateContext: StateContext;
  healthService: HealthService<"liveness" | "readiness" | "connectivity">;
  syncStuckDetector: SyncStuckDetector;
  logger: pino.Logger;
  metricsRegistry: Registry;
};

export const authContextStandalone = (config: ServerConfig): Resource<AuthContext> => {
  const logger = createLogger(config.logging);
  return pipe(
    knexResource(config.db, logger),
    Resource.map((knexInstance) => new PostgresqlUserRepository(knexInstance)),
    Resource.map((repo) => ({ ...prepareAuthContext(config, repo, logger), logger })),
  );
};

export const createStateContext = (config: ServerConfig): Resource<StateContext> => {
  const logger = createLogger(config.logging);
  return pipe(
    knexResource(config.db, logger),
    Resource.map((knexInstance) => ({
      stateSnapshots: new PostgresqlStateSnapshotsRepository(knexInstance, config.identifier),
      taskRepository: new PostgresqlTaskRepository(knexInstance, config.identifier, logger),
      rateCountRepository: new PostgresqlRateCountRepository(knexInstance, logger),
    })),
  );
};

export const defaultRoot = (
  config: ServerConfig,
  mkFaucet: (
    c: ServerConfig,
    logger: pino.Logger,
    cachedState?: {
      shielded: string | undefined;
      unshielded: string | undefined;
      dust: string | undefined;
    },
  ) => Resource<Faucet> = prepareFaucet,
): Resource<CompositionRoot> => {
  const logger = createLogger(config.logging);
  register.setDefaultLabels({
    app: "faucet",
  });
  // TODO: Allow easy rewiring in tests?
  // Probably the best way would to implement memoizing resources and combine
  // them with lazy values to resolve actual values when the tree is being built
  // and thus - allow to rewire everything before use
  // similarly to how in Scala one can use lazy vals and memoizing resources
  return pipe(
    createStateContext(config),
    Resource.mproduct(() => knexResource(config.db, logger)),
    Resource.mapPromise(async ([stateContext, knexDb]) => {
      return {
        stateContext,
        knexDb,
        cachedState: await getState({
          logger,
          stateRepository: stateContext.stateSnapshots,
          encryptionKey: config.encryptionKey,
        }),
      };
    }),
    Resource.mproduct(({ cachedState }) => {
      return mkFaucet(config, logger, cachedState);
    }),
    Resource.mproduct(([{ stateContext }, faucet]) => {
      return TaskManager.create<TokenResponseOutput>(
        logger,
        config.tasks,
        stateContext.taskRepository,
        async (address: string, amount?: bigint | string | null) => {
          // PostgreSQL returns bigint as string, so convert if needed
          const amountBigInt = amount != null ? BigInt(amount) : undefined;
          const response = await faucet.requestTokens(address, logger, amountBigInt);

          return tokenResponseCodec.encode(response);
        },
        faucet.state$.pipe(
          rx.map((state) => {
            logger.debug(`Shielded Sync Progress: ${state.shielded.isSynced}`);
            logger.debug(`Unshielded Sync Progress: ${state.unshielded.isSynced}`);
            logger.debug(`Dust Sync Progress: ${state.dust.isSynced}`);

            const isFullySynced =
              state.dust.isSynced === true && // state.dust.state.progress.isStrictlyComplete()
              state.shielded.isSynced === true && // state.shielded.state.progress.isStrictlyComplete(),
              state.unshielded.isSynced === true; // state.unshielded.syncProgress?.synced

            logger.debug(`isFullySynced to pick up tasks: ${isFullySynced}`);

            return (
              isFullySynced &&
              state.unshielded.syncProgress?.highestTransactionId -
                state.unshielded.syncProgress?.appliedId <=
                50n &&
              state.unshielded.availableBalance > 2n * BigInt(faucet.dropAmount)
            );
          }),
        ),
        {
          refund: (address: string, registeredAt: Date) =>
            stateContext.rateCountRepository.decrement(address, registeredAt),
          reserve: (address: string) =>
            stateContext.rateCountRepository.tryReserve(
              address,
              config.rateLimiting.maxDailyRequests,
            ),
          consume: (address: string) => stateContext.rateCountRepository.increment(address),
        },
      );
    }),
    Resource.map(([[{ stateContext, knexDb }, faucet], taskManager]): CompositionRoot => {
      const connectivitySubscriptions: rx.Subscription[] = [];
      const healthService = new HealthService(
        {
          liveness: {
            /**
             * Checking if available balance allows to cover a single request + fees with some buffer is the only liveness check, this should happen
             * only if the sync progress is close to the tip because the coins might not be fully synced otherwise.
             * Given in some circumstances all coins may be used, a 3 minutes window should be given before
             * forcing a restart (it is the time it should take for a transaction from being requested to change
             * received), so faucet does not collapse under moderate load. Proper tuning of the way transactions
             * are balanced, what is number of concurrent tasks executed, etc. is needed to ensure even high load does
             * not lead to restarts unnecessarily.
             * The reason for checking balance only is that:
             *   - connectivity issues should be gracefully handled and do not indicate faucet is in a state mandating restart
             *   - faucet is able to serve requests even if there is no connection to the indexer for some time
             *   - faucet startup takes time due to sync up needed; thus restarts should be triggered only when necessary
             */
            "faucet-wallet": HealthService.checkFromObservable(
              pipe(
                faucet.state$,
                rx.map((state) => {
                  const { unshielded } = state;

                  // if sync hasn't started we're alive but not ready
                  if (!unshielded.syncProgress) return "not_ok";

                  // if it's fully synced and we have enough balance we're not alive
                  if (
                    unshielded.isSynced &&
                    unshielded.availableBalance < 2n * BigInt(faucet.dropAmount)
                  ) {
                    return "not_ok";
                  }

                  return "ok";
                }),
              ),
            ),
          },
          /**
           * For evaluating if faucet can accept traffic we check if it is reasonably close to the known tip.
           * While it may lead to occasional double spends, the configuration needs to be somewhat lousy, to let
           * the application heal itself and rather catch-up on its own than be forced to restart. This also is
           * important for initial sync-up, which takes significant amount of time and loads CPU noticeably
           */
          readiness: {
            "faucet-sync": HealthService.checkFromObservable(
              pipe(
                faucet.state$,
                rx.map((state) => {
                  if (state.unshielded.syncProgress === undefined) {
                    return "not_ok";
                  }

                  return state.unshielded.syncProgress.highestTransactionId -
                    state.unshielded.syncProgress.appliedId <=
                    200n
                    ? "ok"
                    : "not_ok";
                }),
              ),
            ),
          },
          /**
           * Connectivity checks are performed independently of liveness and readiness to help
           * debugging situations when the other service is not available.
           *
           * These run in the background — probes read the cached result and return
           * immediately, so probe latency is independent of upstream latency or
           * Node event-loop pressure (which under wallet sync load can otherwise
           * cause synchronous fetch-based checks to time-out spuriously).
           */
          connectivity: (() => {
            const checkLogger = logger.child({ scope: "Health checks" });
            const indexerBg = HealthService.makeBackgroundCheck(
              "indexer",
              () => checkIndexer(config.urls.indexer)(logger),
              checkLogger,
            );
            const proofServerBg = HealthService.makeBackgroundCheck(
              "proofServer",
              () => checkProofServer(config.urls.provingServer)(logger),
              checkLogger,
            );
            const nodeServerBg = HealthService.makeBackgroundCheck(
              "node",
              () => checkNode(config.urls.node)(logger),
              checkLogger,
            );
            const databaseBg = HealthService.makeBackgroundCheck(
              "database",
              () => checkDb(knexDb, logger),
              checkLogger,
            );
            connectivitySubscriptions.push(
              indexerBg.subscription,
              proofServerBg.subscription,
              nodeServerBg.subscription,
              databaseBg.subscription,
            );
            return {
              indexer: indexerBg.check,
              proofServer: proofServerBg.check,
              node: nodeServerBg.check,
              database: databaseBg.check,
            };
          })(),
        },
        logger.child({ scope: "Health checks" }),
        connectivitySubscriptions,
      );

      const syncStuckDetector = createSyncStuckDetector(
        faucet.syncErrors$,
        faucet.state$,
        healthService,
        stateContext.stateSnapshots,
        logger.child({ scope: "SyncStuckDetector" }),
      );

      return {
        taskManager,
        faucet,
        stateContext,
        logger,
        healthService,
        syncStuckDetector,
        metricsRegistry: register,
      };
    }),
  );
};
