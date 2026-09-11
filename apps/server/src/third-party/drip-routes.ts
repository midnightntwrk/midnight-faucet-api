import {
  DripErrorCode,
  ThirdPartyDripRequest,
  thirdPartyCreateDripResponseCodec,
  thirdPartyDripInfoResponseCodec,
  thirdPartyDripRequestCodec,
  thirdPartyDripStatusResponseCodec,
  thirdPartyHealthResponseCodec,
  type ThirdPartyHealthResponse,
} from "@midnightntwrk/faucet-internal-api";
import * as express from "express";
import { either } from "fp-ts";
import pino from "pino";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import { TaskManager, TaskStatuses } from "../TaskManager.js";
import { HealthService } from "../health.js";
import { InvalidAddressError, verifyAddress } from "../helpers/verify-address.js";
import { statePersistenceStatus } from "../metrics/index.js";
import { PostgresqlStateSnapshotsRepository } from "../state-persistence/state-persistence-repository.js";
import { PostgresqlTaskRepository } from "../tasks/task-repository.js";
import type { SyncStuckDetector } from "../sync-stuck-detector.js";
import { mkClearStateForRestart } from "../api/drip-routes.js";
import { ThirdPartyApiError, dripError, logAndSendDripError } from "./errors.js";

/**
 * RFC 4122 UUID, which is what `TaskId.generate()` produces. Structural only —
 * it keeps malformed input away from the DB query, and parameterized queries
 * handle SQL safety regardless.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Amounts arrive as an integer string in the token's smallest denomination. */
const AMOUNT_REGEX = /^[0-9]+$/;

export interface ThirdPartyDripRouteDeps {
  taskManager: TaskManager<unknown>;
  taskRepository: PostgresqlTaskRepository;
  stateSnapshots: PostgresqlStateSnapshotsRepository;
  healthService: HealthService<"liveness" | "readiness" | "connectivity">;
  syncStuckDetector: SyncStuckDetector;
  logger: pino.Logger;
  networkId: NetworkId.NetworkId;
  /** The single `network` literal this deployment answers for. */
  network: string;
  /** The single `token` literal this deployment answers for. */
  token: string;
  /** Dispensed when a request omits `amount`, in the smallest denomination. */
  defaultAmount: bigint;
  /** Largest `amount` a single request may ask for, in the smallest denomination. */
  maxAmount: bigint;
}

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

/**
 * Why the faucet cannot serve right now, in the two vocabularies that need it:
 * `reason` is what the caller's UI reads, `internalReason` is the finer-grained
 * one `/api/health` reports and we log, and `code` is what a rejected drip
 * returns.
 */
type HealthVerdict =
  | { readonly _tag: "serving" }
  | {
      readonly _tag: "notServing";
      readonly reason: string;
      readonly internalReason: string;
      readonly code: DripErrorCode;
    };

const notServing = (
  reason: string,
  internalReason: string,
  code: DripErrorCode,
): HealthVerdict => ({ _tag: "notServing", reason, internalReason, code });

/**
 * The same ladder `/api/health` walks, reported in the spec's vocabulary. The
 * caller only distinguishes "the node is unhealthy" from "the wallet is empty",
 * so the internal reasons collapse onto `NODE_DESYNCED` — the distinction stays
 * on `/api/health` and in the logs.
 */
const evaluateHealth = async (
  deps: Pick<ThirdPartyDripRouteDeps, "healthService" | "syncStuckDetector">,
): Promise<HealthVerdict> => {
  const connectivity = await deps.healthService.doChecks("connectivity");
  if (connectivity.status === "not_ok") {
    return notServing("NODE_DESYNCED", "SERVICES_DOWN", "SERVICE_UNAVAILABLE");
  }

  if (deps.syncStuckDetector.needsRestart) {
    return notServing("NODE_DESYNCED", "SYNC_STUCK_RECOVERY", "SERVICE_UNAVAILABLE");
  }

  const persistenceOk = (await statePersistenceStatus.get()).values[0]?.value !== 0;
  if (!persistenceOk) {
    return notServing("INTERNAL_ERROR", "STATE_PERSISTENCE_FAILURE", "SERVICE_UNAVAILABLE");
  }

  const readiness = await deps.healthService.doChecks("readiness");
  if (readiness.status === "not_ok") {
    return notServing("NODE_DESYNCED", "SYNC_BEHIND", "SERVICE_UNAVAILABLE");
  }

  const liveness = await deps.healthService.doChecks("liveness");
  if (liveness.status === "not_ok") {
    return notServing("WALLET_BALANCE_LOW", "WALLET_BALANCE_LOW", "INSUFFICIENT_FUNDS");
  }

  return { _tag: "serving" };
};

const parseRequest = (body: unknown): ThirdPartyDripRequest =>
  either.getOrElseW((): never => {
    throw new ThirdPartyApiError("INVALID_REQUEST", "Malformed request body");
  })(thirdPartyDripRequestCodec.decode(body));

/**
 * One deployment serves exactly one network and one token, so both are an
 * equality check rather than a lookup. Matching case-insensitively keeps a
 * caller sending `NIGHT` for `tNIGHT`-style casing differences out of support.
 */
const verifyNetworkAndToken = (request: ThirdPartyDripRequest, deps: ThirdPartyDripRouteDeps) => {
  if (request.network.toLowerCase() !== deps.network.toLowerCase()) {
    throw new ThirdPartyApiError(
      "UNSUPPORTED_NETWORK",
      `Unsupported network '${request.network}'. This faucet serves '${deps.network}'`,
    );
  }
  if (request.token.toLowerCase() !== deps.token.toLowerCase()) {
    throw new ThirdPartyApiError(
      "UNSUPPORTED_TOKEN",
      `Unsupported token '${request.token}'. This faucet serves '${deps.token}'`,
    );
  }
};

const resolveAmount = (request: ThirdPartyDripRequest, deps: ThirdPartyDripRouteDeps): bigint => {
  const raw = request.amount;
  if (raw === undefined || raw === null || raw === "") {
    return deps.defaultAmount;
  }

  if (!AMOUNT_REGEX.test(raw)) {
    throw new ThirdPartyApiError(
      "INVALID_REQUEST",
      "Invalid amount. Expected an integer string in the token's smallest denomination",
    );
  }

  const amount = BigInt(raw);
  if (amount <= 0n || amount > deps.maxAmount) {
    throw new ThirdPartyApiError(
      "INVALID_REQUEST",
      `Invalid amount. Must be between 1 and ${deps.maxAmount.toString()}`,
    );
  }

  return amount;
};

/**
 * Express routes for the third-party (`/v1`) API, shaped by the Google Drip API
 * specification. The public `/api` surface the UI speaks is a separate
 * implementation (`../api/drip-routes.ts`) and deliberately not shared: the two
 * differ in request shape, amount denomination, error envelope and status codes.
 */
export const createThirdPartyDripRoutes = (deps: ThirdPartyDripRouteDeps): express.Router => {
  const router: express.Router = express.Router();

  const clearStateForRestart = mkClearStateForRestart(deps.stateSnapshots, deps.logger);

  // POST /drips — start a drip
  router.post("/drips", async (req, res) => {
    try {
      const request = parseRequest(req.body);
      verifyNetworkAndToken(request, deps);
      const amount = resolveAmount(request, deps);

      try {
        verifyAddress({ unshieldedAddress: request.recipientAddress, networkId: deps.networkId });
      } catch (error) {
        if (error instanceof InvalidAddressError) {
          throw new ThirdPartyApiError("INVALID_ADDRESS", error.message);
        }
        throw error;
      }

      // `fulfillmentContext` is accepted and carried no further: there is no
      // verification step to evaluate it against yet, and it may hold identity
      // data, so only the shape of it is logged. A future verifier rejecting it
      // is what `VERIFICATION_REJECTED` is reserved for.
      const fulfillmentKeys = Object.keys(request.fulfillmentContext ?? {});

      // Reject up front rather than queueing a drip that cannot be dispensed —
      // the caller renders a deterministic state from the code, and a queued
      // task would instead fail minutes later on a status poll.
      const health = await evaluateHealth(deps);
      if (health._tag === "notServing") {
        throw new ThirdPartyApiError(
          health.code,
          `Faucet is not serving requests: ${health.internalReason}`,
        );
      }

      // registerTask owns the daily limit end to end: it reserves the slot on the
      // create path only (so deduped duplicates don't each spend one — #595) and
      // checks the limit inside that same reservation, which is what stops
      // concurrent requests for one address from all passing a check none of them
      // has paid for yet.
      const registered = await deps.taskManager.registerTask(request.recipientAddress, amount);
      if (registered._tag === "rateLimited") {
        throw new ThirdPartyApiError(
          "RATE_LIMIT_EXCEEDED",
          "This address has no drip left for today",
        );
      }

      deps.logger.info(
        {
          dripId: registered.taskId,
          amount: amount.toString(),
          deduplicated: registered._tag === "deduplicated",
          fulfillmentKeys,
        },
        "Third-party drip request registered",
      );

      // A duplicate of an in-flight request answers with the id of the task it
      // was deduplicated onto: the caller polls the same drip rather than being
      // told its retry was rejected, and no second drip is dispensed.
      return res
        .status(200)
        .json(thirdPartyCreateDripResponseCodec.encode({ dripId: registered.taskId }));
    } catch (error) {
      return logAndSendDripError(res, deps.logger, error, "Third-party drip request refused");
    }
  });

  // GET /drips/:dripId — poll a drip. Always answers 200, per the spec.
  router.get("/drips/:dripId", async (req, res) => {
    const dripId = req.params.dripId;

    if (typeof dripId !== "string" || !UUID_REGEX.test(dripId)) {
      return res.status(200).json(
        thirdPartyDripStatusResponseCodec.encode({
          dripId: typeof dripId === "string" ? dripId : "",
          status: "FAILED",
          transactionHash: null,
          error: dripError("INVALID_REQUEST", "Invalid dripId"),
        }),
      );
    }

    try {
      const statusResponse = await deps.taskManager.getStatus(dripId);
      const status = mapTaskStatusToDripStatus(statusResponse.status);

      const transactionHash =
        statusResponse.status === TaskStatuses.success
          ? ((statusResponse.value as { transactionIdentifier?: string })?.transactionIdentifier ??
            null)
          : null;

      // A failed status covers two different answers — the drip failed, or there
      // is no such drip — and the caller needs to tell them apart. Only the
      // failure path pays for the extra lookup.
      const error =
        status === "FAILED"
          ? (await deps.taskRepository.getById(dripId)) === undefined
            ? dripError("INVALID_REQUEST", `No drip with id ${dripId}`)
            : dripError(
                "INTERNAL_ERROR",
                (statusResponse as { error?: string }).error ?? "Drip failed",
              )
          : null;

      deps.logger.debug({ dripId, taskStatus: statusResponse.status }, "Third-party drip polled");

      return res
        .status(200)
        .json(thirdPartyDripStatusResponseCodec.encode({ dripId, status, transactionHash, error }));
    } catch (thrown) {
      deps.logger.error({ err: thrown, dripId }, "Error getting third-party drip status");
      return res.status(200).json(
        thirdPartyDripStatusResponseCodec.encode({
          dripId,
          status: "FAILED",
          transactionHash: null,
          error: dripError("INTERNAL_ERROR", "Could not read drip status"),
        }),
      );
    }
  });

  // GET /drip-info/:network/:token — the amount an omitted `amount` gets
  router.get("/drip-info/:network/:token", (req, res) => {
    const { network, token } = req.params;

    if (typeof network !== "string" || network.toLowerCase() !== deps.network.toLowerCase()) {
      return logAndSendDripError(
        res,
        deps.logger,
        new ThirdPartyApiError(
          "UNSUPPORTED_NETWORK",
          `Unsupported network '${String(network)}'. This faucet serves '${deps.network}'`,
        ),
        "Third-party drip-info refused",
      );
    }

    if (typeof token !== "string" || token.toLowerCase() !== deps.token.toLowerCase()) {
      return logAndSendDripError(
        res,
        deps.logger,
        new ThirdPartyApiError(
          "UNSUPPORTED_TOKEN",
          `Unsupported token '${String(token)}'. This faucet serves '${deps.token}'`,
        ),
        "Third-party drip-info refused",
      );
    }

    return res
      .status(200)
      .json(thirdPartyDripInfoResponseCodec.encode({ dripAmount: deps.defaultAmount.toString() }));
  });

  // GET /health — faucet health, always 200 so the poller reads the body
  router.get("/health", async (_req, res) => {
    // Clear the persisted state as soon as the detector signals a restart,
    // before any other check can decide the response — whatever restarts the
    // process must not resume from the snapshot that wedged it.
    if (deps.syncStuckDetector.needsRestart) {
      await clearStateForRestart();
    }

    try {
      const verdict = await evaluateHealth(deps);

      if (verdict._tag === "notServing") {
        deps.logger.debug({ reason: verdict.internalReason }, "Third-party health: NOT_SERVING");
        const response: ThirdPartyHealthResponse = {
          status: "NOT_SERVING",
          reason: verdict.reason,
        };
        return res.status(200).json(thirdPartyHealthResponseCodec.encode(response));
      }

      const response: ThirdPartyHealthResponse = { status: "SERVING", reason: null };
      return res.status(200).json(thirdPartyHealthResponseCodec.encode(response));
    } catch (error) {
      deps.logger.error({ err: error }, "Error checking third-party health");
      const response: ThirdPartyHealthResponse = {
        status: "NOT_SERVING",
        reason: "INTERNAL_ERROR",
      };
      return res.status(200).json(thirdPartyHealthResponseCodec.encode(response));
    }
  });

  return router;
};
