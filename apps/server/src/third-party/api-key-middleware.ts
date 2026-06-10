import { Request, Response, NextFunction } from "express";
import * as crypto from "node:crypto";

export const apiKeyMiddleware = (apiKey: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const providedKey = req.get("X-API-Key");

    if (!providedKey) {
      return res.status(401).json({ error: "API key required" });
    }

    const providedKeyBuf = Buffer.from(providedKey);
    const expectedKeyBuf = Buffer.from(apiKey);

    // Check length first, then use constant-time comparison for content
    const lengthMatch = providedKeyBuf.length === expectedKeyBuf.length;
    const contentMatch = lengthMatch && crypto.timingSafeEqual(providedKeyBuf, expectedKeyBuf);

    if (!contentMatch) {
      return res.status(403).json({ error: "Invalid API key" });
    }

    next();
  };
};
