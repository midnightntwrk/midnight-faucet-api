import type { Response } from "express";
import type pino from "pino";
import {
  DripError,
  DripErrorCode,
  thirdPartyErrorResponseCodec,
} from "@midnight-ntwrk/faucet-internal-api";

/**
 * The HTTP status the spec pairs with each error code. `INVALID_REQUEST` is our
 * own extension for a malformed body or an out-of-range amount — the spec has no
 * literal for either, and an unrecognised one is defaulted to `INTERNAL_ERROR`
 * by the caller, so 400 stays the honest status.
 */
export const DRIP_ERROR_HTTP_STATUS: Readonly<Record<DripErrorCode, number>> = {
  INVALID_ADDRESS: 400,
  UNSUPPORTED_NETWORK: 400,
  UNSUPPORTED_TOKEN: 400,
  INVALID_API_KEY: 401,
  VERIFICATION_REJECTED: 403,
  DUPLICATE_CLAIM: 409,
  RATE_LIMIT_EXCEEDED: 429,
  INSUFFICIENT_FUNDS: 503,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
  INVALID_REQUEST: 400,
};

/**
 * A request the third-party API refuses, carrying the code the caller renders a
 * deterministic UI state from. Thrown by the validation steps and turned into a
 * response by {@link sendDripError} at the route boundary.
 */
export class ThirdPartyApiError extends Error {
  readonly name = "ThirdPartyApiError";

  constructor(
    readonly code: DripErrorCode,
    message: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const dripError = (code: DripErrorCode, message: string | null): DripError => ({
  code,
  message,
});

/**
 * Maps anything thrown on a request path to the code reported to the caller.
 * Only a {@link ThirdPartyApiError} carries a deliberate code; everything else is
 * an unhandled vendor-side failure, which the spec calls `INTERNAL_ERROR`.
 */
export const toDripError = (error: unknown): DripError =>
  error instanceof ThirdPartyApiError
    ? dripError(error.code, error.message)
    : dripError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));

export const sendDripError = (res: Response, error: DripError): Response =>
  res
    .status(DRIP_ERROR_HTTP_STATUS[error.code])
    .json(thirdPartyErrorResponseCodec.encode({ error }));

export const logAndSendDripError = (
  res: Response,
  logger: pino.Logger,
  thrown: unknown,
  context: string,
): Response => {
  const error = toDripError(thrown);
  // Only an INTERNAL_ERROR is ours to act on; the rest are the caller's inputs
  // and would drown the logs at error level.
  if (error.code === "INTERNAL_ERROR") {
    logger.error({ err: thrown, code: error.code }, context);
  } else {
    logger.info({ code: error.code, reason: error.message }, context);
  }
  return sendDripError(res, error);
};
