/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/require-await */
import {
  dripRequestCodec,
  dripResponseCodec,
  dripHealthResponseCodec,
  DripResponse,
  DripHealthResponse,
} from "@midnightntwrk/faucet-internal-api";
import { pipe, Task } from "@midnightntwrk/faucet-utils";
import * as express from "express";
import { either } from "fp-ts";
import * as t from "io-ts";
import { PathReporter } from "io-ts/lib/PathReporter.js";
import pino from "pino";
import { TaskManager, TaskStatuses } from "../TaskManager.js";
import { RateLimitError } from "../rate-limiting/rate-limit-error.js";
import { verifyAddress, InvalidAddressError } from "../helpers/verify-address.js";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import { PostgresqlTaskRepository } from "../tasks/task-repository.js";
import { PostgresqlStateSnapshotsRepository } from "../state-persistence/state-persistence-repository.js";
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
  stateSnapshots: PostgresqlStateSnapshotsRepository;
  healthService: HealthService<"liveness" | "readiness" | "connectivity">;
  syncStuckDetector: SyncStuckDetector;
  logger: pino.Logger;
  networkId: NetworkId.NetworkId;
  maxAmount: number;
}

/**
 * How many times the state clear is retried if the truncate keeps failing. A
 * failing DB is exactly when recovery is needed, but an unbounded retry would
 * turn every health poll into another TRUNCATE and another error log.
 */
export const CLEAR_STATE_MAX_ATTEMPTS = 3;

/**
 * Builds the "clear the persisted wallet state" step that runs when the API
 * starts reporting `needsRestart`, so whatever restarts the process cannot
 * resume from the snapshot that wedged it.
 *
 * The detector truncates `state_snapshots` itself before latching
 * `needsRestart`, but that write can fail and is never retried once the latch is
 * set — leaving a snapshot the next process would happily load, straight back
 * into the wedged state. This closes that gap at the point the restart is
 * actually signalled.
 *
 * The returned function runs the truncate at most once (up to
 * {@link CLEAR_STATE_MAX_ATTEMPTS} attempts if it rejects) and never rejects:
 * the health probe must still deliver the restart signal even if the clear
 * failed. Mutable latch state is the accepted exception to the const-only rule
 * here — it bridges a continuously polled probe to a one-shot side effect.
 */
export const mkClearStateForRestart = (
  stateSnapshots: Pick<PostgresqlStateSnapshotsRepository, "truncate">,
  logger: pino.Logger,
): (() => Promise<void>) => {
  let inFlight: Promise<void> | null = null;
  let attempts = 0;

  return () => {
    if (inFlight !== null) return inFlight;
    if (attempts >= CLEAR_STATE_MAX_ATTEMPTS) return Promise.resolve();

    attempts = attempts + 1;
    const attempt = attempts;

    inFlight = stateSnapshots
      .truncate(logger)
      .then(() => {
        logger.warn({ attempt }, "Cleared state_snapshots after sync-stuck restart signal");
      })
      .catch((error: unknown) => {
        // Release the latch so a later poll can retry within the attempt cap.
        inFlight = null;
        logger.error(
          { err: error, attempt },
          "Failed to clear state_snapshots after sync-stuck restart signal",
        );
      });

    return inFlight;
  };
};

/**
 * Creates Express route handlers for the drip API.
 * Both public and third-party routers mount these routes,
 * each applying their own auth middleware beforehand.
 */
export const createDripRoutes = (deps: DripRouteDeps): express.Router => {
  const router: express.Router = express.Router();

  // One latch per mounted router (public and third-party each mount these
  // routes), so at most one truncate per mount. TRUNCATE is idempotent, so the
  // worst case is a second no-op clear of an already empty table.
  const clearStateForRestart = mkClearStateForRestart(deps.stateSnapshots, deps.logger);

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
        return request;
      }),
      Task.flatMapPromise(async (request) => {
        // registerTask owns the daily limit end to end: it reserves the slot on the
        // create path only (so deduped duplicates don't each spend one — #595) and
        // checks the limit inside that same reservation, which is what stops
        // concurrent requests for one address from all passing a check none of them
        // has paid for yet.
        const registered = await deps.taskManager.registerTask(
          request.recipientAddress,
          request.amount * TNIGHT_UNIT,
        );
        if (registered._tag === "rateLimited") {
          throw RateLimitError.in24Hours();
        }
        return registered.taskId;
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

    // Clear the persisted state as soon as the API signals a restart, before any
    // other check can decide the response — the signal is carried on every
    // response (`needsRestart`), not just the SYNC_STUCK_RECOVERY one, so an
    // orchestrator reading it during a connectivity outage must still find the
    // snapshot gone.
    if (needsRestart) {
      await clearStateForRestart();
    }

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
