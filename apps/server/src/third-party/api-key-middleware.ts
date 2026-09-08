import { Request, Response, NextFunction } from "express";
import * as crypto from "node:crypto";
import { ThirdPartyApiError, sendDripError, toDripError } from "./errors.js";

/**
 * Header-based API key authentication for the third-party API.
 *
 * A missing key and a wrong key answer identically (`INVALID_API_KEY`, 401), as
 * the spec requires — the caller has no use for the difference, and telling them
 * apart tells a prober which half of the guess was right.
 *
 * An unconfigured key disables the API rather than accepting the empty string.
 */
export const apiKeyMiddleware = (apiKey: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (apiKey.length === 0) {
      return sendDripError(
        res,
        toDripError(
          new ThirdPartyApiError("SERVICE_UNAVAILABLE", "Third-party API is not configured"),
        ),
      );
    }

    const providedKey = req.get("X-API-Key");
    const invalidKey = new ThirdPartyApiError("INVALID_API_KEY", "Missing or invalid API key");

    if (providedKey === undefined || providedKey.length === 0) {
      return sendDripError(res, toDripError(invalidKey));
    }

    const providedKeyBuf = Buffer.from(providedKey);
    const expectedKeyBuf = Buffer.from(apiKey);

    // Check length first, then use constant-time comparison for content
    const lengthMatch = providedKeyBuf.length === expectedKeyBuf.length;
    const contentMatch = lengthMatch && crypto.timingSafeEqual(providedKeyBuf, expectedKeyBuf);

    if (!contentMatch) {
      return sendDripError(res, toDripError(invalidKey));
    }

    next();
  };
};
