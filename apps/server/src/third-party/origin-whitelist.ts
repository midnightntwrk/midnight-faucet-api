import { Request, Response, NextFunction } from "express";

export const originWhitelistMiddleware = (allowedOrigins: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip origin check if no origins are configured (disabled)
    if (allowedOrigins.length === 0) {
      return res.status(403).json({
        error: "Third-party API is not configured",
      });
    }

    const origin = req.get("origin");

    if (!origin) {
      return res.status(403).json({
        error: "Origin not allowed",
      });
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
      return res.status(403).json({
        error: "Origin not allowed",
      });
    }

    next();
  };
};
