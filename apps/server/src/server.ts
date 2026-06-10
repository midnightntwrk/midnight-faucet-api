import { writeHeapSnapshot } from "node:v8";
import { pipe, Resource, Task } from "@midnight-ntwrk/faucet-utils";
import express, { Router } from "express";
import * as http from "node:http";
import pino from "pino";
import { timer, Subscription, exhaustMap } from "rxjs";
import { ServerConfig } from "./config.js";
import { appRouter, metricsAppRouter } from "./router.js";
import { CompositionRoot } from "./composition-root.js";
import {
  totalAvailableFunds,
  syncProgressApplyGap,
  shieldedAvailableBalance,
  shieldedCoinCount,
  shieldedSynced,
  unshieldedAvailableBalance,
  unshieldedCoinCount,
  unshieldedSynced,
  unshieldedConnected,
  dustAvailableBalance,
  dustPendingBalance,
  dustCoinCount,
  dustSynced,
  statePersistenceStatus,
} from "./metrics/index.js";
import { saveState } from "./state-persistence/serialize-and-save-state.js";

interface Server {
  statePersistenceSubscription: Subscription;
  fundsSubscription: Subscription;
  heapLogSubscription: Subscription;
}

const mkHttpServer = (
  port: number,
  host: string,
  router: Router,
  logger: pino.Logger,
  logMsg: string,
): Resource<http.Server> => {
  return Resource.make(
    Task.lift(
      () =>
        new Promise((resolve) => {
          const app = express();
          app.use(router);
          resolve(
            app.listen(port, host, () => {
              logger.info({ port, host }, logMsg);
            }),
          );
        }),
    ),
    (server) =>
      Task.lift(
        () =>
          new Promise((resolve, reject) => {
            server.close((maybeError) => {
              if (maybeError) {
                return reject(maybeError);
              }
              resolve();
            });
          }),
      ),
  );
};

const mkServerResource = (
  config: ServerConfig,
  root: CompositionRoot,
  router: Router,
  metricsRouter: Router,
): Resource<Server> => {
  const { faucet, logger, stateContext } = root;
  return pipe(
    mkHttpServer(config.port, config.host, router, logger, "Server started"),
    Resource.mproduct(() =>
      mkHttpServer(
        config.metricsPort,
        config.host,
        metricsRouter,
        logger,
        "Metrics Server started",
      ),
    ),
    Resource.flatMap(([httpServer, metricsServer]) =>
      Resource.make(
        Task.lift(() => {
          root.syncStuckDetector.start();

          const fundsSubscription = faucet.state$
            .pipe(
              exhaustMap(async (value) => {
                try {
                  syncProgressApplyGap.set(
                    Number(
                      value.unshielded.syncProgress?.highestTransactionId -
                        value.unshielded.syncProgress?.appliedId,
                    ),
                  );
                  totalAvailableFunds.set(Number(value.unshielded.availableBalance));
                  unshieldedAvailableBalance.set(Number(value.unshielded.availableBalance));
                  unshieldedCoinCount.set(value.unshielded.availableCoins.length);
                  unshieldedSynced.set(value.unshielded.isSynced ? 1 : 0);
                  unshieldedConnected.set(value.unshielded.syncProgress?.isConnected ? 1 : 0);

                  shieldedAvailableBalance.set(Number(value.shielded.availableBalance));
                  shieldedCoinCount.set(value.shielded.availableCoins.length);
                  shieldedSynced.set(value.shielded.isSynced ? 1 : 0);

                  dustAvailableBalance.set(Number(value.dust.availableBalance));
                  dustPendingBalance.set(
                    value.dust.pendingCoins.reduce((sum, coin) => sum + Number(coin), 0),
                  );
                  dustCoinCount.set(value.dust.availableCoins.length);
                  dustSynced.set(value.dust.isSynced ? 1 : 0);
                  return Promise.resolve();
                } catch (error) {
                  logger.error({ err: error }, "Error updating metrics");
                  return Promise.resolve();
                }
              }),
            )
            .subscribe({
              error: (error) => logger.error({ err: error }, "Faucet wallet error"),
            });

          const persistWalletState = async (): Promise<void> => {
            if (root.syncStuckDetector.needsRestart) {
              logger.warn("Skipping state persistence — sync stuck recovery in progress");
              return;
            }

            const state = faucet.serializeWalletState();

            const shieldedState = await state.shielded;
            const unshieldedState = await state.unshielded;
            const dustState = await state.dust;

            try {
              await saveState({
                shieldedState,
                unshieldedState,
                dustState,
                stateContext,
                logger,
                encryptionKey: config.encryptionKey,
              });
              statePersistenceStatus.set(1);
            } catch (error) {
              statePersistenceStatus.set(0);
              logger.error({ err: error }, "Failed to persist wallet state");
            }
          };

          const statePersistenceInterval = 1000 * 900;
          const statePersistenceSubscription = timer(0, statePersistenceInterval).subscribe(() => {
            // Intentional fire-and-forget: rxjs `subscribe` expects a sync
            // void-returning callback. Errors inside `persistWalletState`
            // are caught and logged internally; nothing else needs to await
            // the result. Wrapping in `void` keeps `no-misused-promises`
            // satisfied without disabling the rule.
            void persistWalletState();
          });

          const autoSnapshotsAt = [1000, 2000]; // MB thresholds for auto heap snapshots
          const snapshotsTaken = new Set<number>();
          const heapLogSubscription = timer(0, 10_000).subscribe(() => {
            const mem = process.memoryUsage();
            const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
            logger.info(
              {
                heapUsedMb,
                heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
                rssMb: Math.round(mem.rss / 1024 / 1024),
                externalMb: Math.round(mem.external / 1024 / 1024),
                arrayBuffersMb: Math.round(mem.arrayBuffers / 1024 / 1024),
              },
              "memory",
            );

            for (const threshold of autoSnapshotsAt) {
              if (heapUsedMb >= threshold && !snapshotsTaken.has(threshold)) {
                snapshotsTaken.add(threshold);
                const path = `/tmp/heap-auto-${threshold}mb-${Date.now()}.heapsnapshot`;
                logger.warn({ threshold, heapUsedMb, path }, "Auto heap snapshot triggered");
                try {
                  writeHeapSnapshot(path);
                  logger.warn({ path }, "Auto heap snapshot written");
                } catch (err) {
                  logger.error({ err }, "Auto heap snapshot failed");
                }
              }
            }
          });

          return Promise.resolve({
            server: httpServer,
            metricsServer,
            statePersistenceSubscription,
            fundsSubscription,
            heapLogSubscription,
          });
        }),
        (server) =>
          Task.delay(() => {
            logger.trace("Stopping server");
            root.syncStuckDetector.stop();
            root.healthService.dispose();
            server.statePersistenceSubscription.unsubscribe();
            server.fundsSubscription.unsubscribe();
            server.heapLogSubscription.unsubscribe();
          }),
      ),
    ),
  );
};

export function prepareServer(config: ServerConfig, root: CompositionRoot): Resource<Server> {
  return mkServerResource(config, root, appRouter(config, root), metricsAppRouter(root));
}
