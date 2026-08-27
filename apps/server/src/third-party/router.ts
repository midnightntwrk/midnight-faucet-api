import * as express from "express";
import pino from "pino";
import { TaskManager } from "../TaskManager.js";
import { ThirdPartyApiConfig } from "../config.js";
import { originWhitelistMiddleware } from "./origin-whitelist.js";
import { apiKeyMiddleware } from "./api-key-middleware.js";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import { PostgresqlTaskRepository } from "../tasks/task-repository.js";
import { PostgresqlStateSnapshotsRepository } from "../state-persistence/state-persistence-repository.js";
import { HealthService } from "../health.js";
import { thirdPartyHttpRequestTimer } from "../metrics/index.js";
import { createThirdPartyDripRoutes, type ThirdPartyDripRouteDeps } from "./drip-routes.js";
import type { SyncStuckDetector } from "../sync-stuck-detector.js";

export interface ThirdPartyDeps {
  config: ThirdPartyApiConfig;
  taskManager: TaskManager<unknown>;
  taskRepository: PostgresqlTaskRepository;
  stateSnapshots: PostgresqlStateSnapshotsRepository;
  healthService: HealthService<"liveness" | "readiness" | "connectivity">;
  syncStuckDetector: SyncStuckDetector;
  logger: pino.Logger;
  networkId: NetworkId.NetworkId;
}

export const thirdPartyRouter = (deps: ThirdPartyDeps): express.Router => {
  const router: express.Router = express.Router();

  // Apply origin whitelist and API key middleware
  router.use(originWhitelistMiddleware(deps.config.allowedOrigins, deps.config.requireOrigin));
  router.use(apiKeyMiddleware(deps.config.apiKey));
  router.use(express.json());

  // HTTP request timing middleware
  router.use((req, res, next) => {
    const timer = thirdPartyHttpRequestTimer.startTimer();
    res.once("finish", () => {
      // Type cast required because: Express types `req.route` as `any`, and the
      // metric label needs the matched route pattern rather than the concrete
      // path, so ids don't explode the label cardinality.
      const route = req.route as { path?: string } | undefined;
      const endpoint = route?.path ?? req.path;
      timer({
        method: req.method,
        endpoint,
        status_code: res.statusCode.toString(),
      });
    });
    next();
  });

  const dripDeps: ThirdPartyDripRouteDeps = {
    taskManager: deps.taskManager,
    taskRepository: deps.taskRepository,
    stateSnapshots: deps.stateSnapshots,
    healthService: deps.healthService,
    syncStuckDetector: deps.syncStuckDetector,
    logger: deps.logger,
    networkId: deps.networkId,
    network: deps.config.network,
    token: deps.config.token,
    defaultAmount: BigInt(deps.config.defaultAmount),
    maxAmount: BigInt(deps.config.maxAmount),
  };
  router.use(createThirdPartyDripRoutes(dripDeps));

  return router;
};
