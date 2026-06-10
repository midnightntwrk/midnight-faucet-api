/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/require-await */
import {
  dripRequestCodec,
  dripResponseCodec,
  dripHealthResponseCodec,
  DripResponse,
  DripHealthResponse,
} from "@midnight-ntwrk/faucet-internal-api";
import { pipe, Task } from "@midnight-ntwrk/faucet-utils";
import * as express from "express";
import { either } from "fp-ts";
import * as t from "io-ts";
import { PathReporter } from "io-ts/lib/PathReporter.js";
import { DateTime } from "luxon";
import pino from "pino";
import { TaskManager, TaskStatuses } from "../TaskManager.js";
import { RateLimitError } from "../rate-limiting/rate-limiting.js";
import { verifyAddress, InvalidAddressError } from "../helpers/verify-address.js";
import { NetworkId } from "@midnight-ntwrk/wallet-sdk-abstractions";
import { PostgresqlRateCountRepository } from "../rate-counts/rate-counts-repository.js";
import { PostgresqlTaskRepository } from "../tasks/task-repository.js";
import { HealthService } from "../health.js";
import { statePersistenceStatus } from "../metrics/index.js";
import type { SyncStuckDetector } from "../sync-stuck-detector.js";

class DecodingError extends Error {
  constructor(public readonly errors: t.Errors) {
    super(pipe(errors, t.failures, PathReporter.report, (arr) => arr.join("\n")));
  }
}

class ValidationError extends Error {}

const parseWithCodec =
  <T>(codec: t.Type<T, unknown, unknown>) =>
  (request: { body: unknown }): Task<T> =>
    pipe(
      request.body,
      codec.decode,
      either.fold(
        (errors: t.Errors) => Task.raiseError(new DecodingError(errors)),
        (value: T) => Task.of(value),
      ),
    );

const TNIGHT_UNIT = 5_000_000n;

// RFC 4122 UUID format. Matches what `crypto.randomUUID()` produces in
// `TaskId.generate()`. Validation is structural only — preventing malformed
// inputs from reaching the DB query. Parameterized queries handle SQL safety
// regardless.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mapTaskStatusToDripStatus = (taskStatus: string): "PENDING" | "CONFIRMED" | "FAILED" => {
  switch (taskStatus) {
    case TaskStatuses.scheduled:
    case TaskStatuses.in_progress:
      return "PENDING";
    case TaskStatuses.success:
      return "CONFIRMED";
    case TaskStatuses.failure:
    default:
      return "FAILED";
  }
};

export interface DripRouteDeps {
  taskManager: TaskManager<unknown>;
  taskRepository: PostgresqlTaskRepository;
  rateCountRepository: PostgresqlRateCountRepository;
  healthService: HealthService<"liveness" | "readiness" | "connectivity">;
  syncStuckDetector: SyncStuckDetector;
  logger: pino.Logger;
  networkId: NetworkId.NetworkId;
  maxDailyRequests: number;
  maxAmount: number;
}

/**
 * Creates Express route handlers for the drip API.
 * Both public and third-party routers mount these routes,
 * each applying their own auth middleware beforehand.
 */
export const createDripRoutes = (deps: DripRouteDeps): express.Router => {
  const router: express.Router = express.Router();

  const validateRateLimit = async (address: string) => {
    const rateCount = await deps.rateCountRepository.get(address);
    const now = DateTime.now().startOf("day");
    const updated = DateTime.fromJSDate(rateCount.updated_at).startOf("day");
    if (now <= updated) {
      if (rateCount.count >= deps.maxDailyRequests) {
        throw RateLimitError.in24Hours();
      }
      return;
    }
    await deps.rateCountRepository.reset(address);
  };

  const validateAmount = (amount: bigint): void => {
    if (amount <= 0n || amount > BigInt(deps.maxAmount)) {
      throw new ValidationError(`Invalid amount. Must be between 1 and ${deps.maxAmount}`);
    }
  };

  // POST /drips — Request a drip
  router.post("/drips", async (req, res) => {
    await pipe(
      req,
      parseWithCodec(dripRequestCodec),
      Task.flatMapPromise(async (request) => {
        validateAmount(request.amount);
        verifyAddress({ unshieldedAddress: request.recipientAddress, networkId: deps.networkId });
        await validateRateLimit(request.recipientAddress);
        return request;
      }),
      Task.flatMapPromise(async (request) => {
        const dripId = await deps.taskManager.registerTask(
          request.recipientAddress,
          request.amount * TNIGHT_UNIT,
        );
        // Increment rate count at creation time to prevent bypass via not polling
        await deps.rateCountRepository.increment(request.recipientAddress);
        return dripId;
      }),
      Task.flatMap((dripId) =>
        Task.delay(() => {
          deps.logger.info({ dripId }, "Drip request registered");
          const response: DripResponse = {
            dripId,
            status: "PENDING",
            taskStatus: "scheduled",
            transactionHash: null,
            error: null,
          };
          return res.json(dripResponseCodec.encode(response));
        }),
      ),
      Task.catchError((error) => {
        deps.logger.error({ err: error }, "Error processing drip request");
        if (error instanceof DecodingError) {
          return Task.lift(async () => res.status(400).json({ error: error.message }));
        } else if (error instanceof RateLimitError) {
          return Task.lift(async () => res.status(429).json({ error: error.message }));
        } else if (error instanceof InvalidAddressError || error instanceof ValidationError) {
          return Task.lift(async () => res.status(400).json({ error: error.message }));
        } else {
          return Task.lift(async () => res.status(500).json({ error: "Internal error" }));
        }
      }),
      Task.unsafeRun,
    );
  });

  // GET /drips/:dripId — Get drip status
  router.get("/drips/:dripId", (req, res) => {
    const dripId = req.params.dripId;

    if (typeof dripId !== "string" || !UUID_REGEX.test(dripId)) {
      return res.status(400).json({ error: "Invalid dripId" });
    }

    return pipe(
      Task.lift(() => deps.taskManager.getStatus(dripId)),
      Task.flatMapPromise(async (statusResponse) => {
        deps.logger.debug({ dripId, taskStatus: statusResponse.status }, "Drip status polled");
        const response: DripResponse = {
          dripId,
          status: mapTaskStatusToDripStatus(statusResponse.status),
          taskStatus: statusResponse.status,
          transactionHash:
            statusResponse.status === TaskStatuses.success
              ? ((statusResponse.value as { transactionIdentifier?: string })
                  ?.transactionIdentifier ?? null)
              : null,
          error:
            statusResponse.status === TaskStatuses.failure
              ? ((statusResponse as { error?: string }).error ?? null)
              : null,
        };
        return response;
      }),
      Task.map((response) => res.json(dripResponseCodec.encode(response))),
      Task.catchError((error) => {
        deps.logger.error({ err: error }, "Error getting drip status");
        return Task.lift(async () => res.status(500).json({ error: error.message }));
      }),
      Task.unsafeRun,
    );
  });

  // GET /health — Service health
  router.get("/health", async (_req, res) => {
    const needsRestart = deps.syncStuckDetector.needsRestart;
    try {
      const connectivityResult = await deps.healthService.doChecks("connectivity");
      if (connectivityResult.status === "not_ok") {
        const response: DripHealthResponse = {
          status: "NOT_SERVING",
          reason: "SERVICES_DOWN",
          needsRestart,
        };
        return res.status(503).json(dripHealthResponseCodec.encode(response));
      }

      if (needsRestart) {
        const response: DripHealthResponse = {
          status: "NOT_SERVING",
          reason: "SYNC_STUCK_RECOVERY",
          needsRestart,
        };
        return res.status(503).json(dripHealthResponseCodec.encode(response));
      }

      const persistenceOk = (await statePersistenceStatus.get()).values[0]?.value !== 0;
      if (!persistenceOk) {
        const response: DripHealthResponse = {
          status: "NOT_SERVING",
          reason: "STATE_PERSISTENCE_FAILURE",
          needsRestart,
        };
        return res.status(503).json(dripHealthResponseCodec.encode(response));
      }

      const readinessResult = await deps.healthService.doChecks("readiness");
      if (readinessResult.status === "not_ok") {
        const response: DripHealthResponse = {
          status: "NOT_SERVING",
          reason: "SYNC_BEHIND",
          needsRestart,
        };
        return res.status(503).json(dripHealthResponseCodec.encode(response));
      }

      const livenessResult = await deps.healthService.doChecks("liveness");
      if (livenessResult.status === "not_ok") {
        const response: DripHealthResponse = {
          status: "NOT_SERVING",
          reason: "WALLET_BALANCE_LOW",
          needsRestart,
        };
        return res.status(503).json(dripHealthResponseCodec.encode(response));
      }

      const response: DripHealthResponse = { status: "SERVING", reason: null, needsRestart };
      return res.status(200).json(dripHealthResponseCodec.encode(response));
    } catch (error) {
      deps.logger.error({ err: error }, "Error checking health");
      const response: DripHealthResponse = {
        status: "NOT_SERVING",
        reason: "INTERNAL_ERROR",
        needsRestart,
      };
      return res.status(503).json(dripHealthResponseCodec.encode(response));
    }
  });

  return router;
};
