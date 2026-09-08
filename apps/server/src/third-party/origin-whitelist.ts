import { Request, Response, NextFunction } from "express";
import { ThirdPartyApiError, sendDripError, toDripError } from "./errors.js";

/**
 * Optional `Origin` allow-list for the third-party API.
 *
 * Off by default: the API key is the credential, and a server-to-server caller
 * sends no `Origin` header at all, so enforcing it would reject every backend
 * integration. Turn it on (`THIRD_PARTY_REQUIRE_ORIGIN`) only for partners
 * calling from a browser, where the header is present and attacker-controlled
 * origins are the thing being kept out.
 */
export const originWhitelistMiddleware = (allowedOrigins: string[], required: boolean) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!required) {
      return next();
    }

    const rejected = new ThirdPartyApiError("VERIFICATION_REJECTED", "Origin not allowed");

    if (allowedOrigins.length === 0) {
      return sendDripError(
        res,
        toDripError(
          new ThirdPartyApiError(
            "SERVICE_UNAVAILABLE",
            "Third-party API requires an origin allow-list, but none is configured",
          ),
        ),
      );
    }

    const origin = req.get("origin");

    if (origin === undefined) {
      return sendDripError(res, toDripError(rejected));
    }

    // Use URL parsing for exact origin match to prevent subdomain bypass
    const isAllowed = allowedOrigins.some((allowed) => {
      try {
        return new URL(origin).origin === new URL(allowed).origin;
      } catch {
        return false;
      }
    });

    if (!isAllowed) {
      return sendDripError(res, toDripError(rejected));
    }

    next();
  };
};
