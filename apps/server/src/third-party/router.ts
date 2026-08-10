/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import * as express from "express";
import pino from "pino";
import { TaskManager } from "../TaskManager.js";
import { ThirdPartyApiConfig } from "../config.js";
import { originWhitelistMiddleware } from "./origin-whitelist.js";
import { apiKeyMiddleware } from "./api-key-middleware.js";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import { PostgresqlRateCountRepository } from "../rate-counts/rate-counts-repository.js";
import { PostgresqlTaskRepository } from "../tasks/task-repository.js";
import { PostgresqlStateSnapshotsRepository } from "../state-persistence/state-persistence-repository.js";
import { HealthService } from "../health.js";
import { thirdPartyHttpRequestTimer } from "../metrics/index.js";
import { createDripRoutes, type DripRouteDeps } from "../api/drip-routes.js";
import type { SyncStuckDetector } from "../sync-stuck-detector.js";

export interface ThirdPartyDeps {
  config: ThirdPartyApiConfig;
  taskManager: TaskManager<unknown>;
  taskRepository: PostgresqlTaskRepository;
  rateCountRepository: PostgresqlRateCountRepository;
  stateSnapshots: PostgresqlStateSnapshotsRepository;
  healthService: HealthService<"liveness" | "readiness" | "connectivity">;
  syncStuckDetector: SyncStuckDetector;
  logger: pino.Logger;
  networkId: NetworkId.NetworkId;
  maxDailyRequests: number;
}

export const thirdPartyRouter = (deps: ThirdPartyDeps): express.Router => {
  const router: express.Router = express.Router();

  // Apply origin whitelist and API key middleware
  router.use(originWhitelistMiddleware(deps.config.allowedOrigins));
  router.use(apiKeyMiddleware(deps.config.apiKey));
  router.use(express.json());

  // HTTP request timing middleware
  router.use((req, res, next) => {
    const timer = thirdPartyHttpRequestTimer.startTimer();
    res.once("finish", () => {
      const endpoint = req.route?.path ?? req.path;
      timer({
        method: req.method,
        endpoint,
        status_code: res.statusCode.toString(),
      });
    });
    next();
  });

  // Shared drip routes (POST /drips, GET /drips/:dripId, GET /health)
  const dripDeps: DripRouteDeps = {
    taskManager: deps.taskManager,
    taskRepository: deps.taskRepository,
    rateCountRepository: deps.rateCountRepository,
    stateSnapshots: deps.stateSnapshots,
    healthService: deps.healthService,
    syncStuckDetector: deps.syncStuckDetector,
    logger: deps.logger,
    networkId: deps.networkId,
    maxDailyRequests: deps.maxDailyRequests,
    maxAmount: deps.config.maxAmount,
  };
  router.use(createDripRoutes(dripDeps));

  return router;
};
