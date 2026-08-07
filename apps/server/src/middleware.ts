import fs from "fs";
import path from "path";
import type { Request, Response, NextFunction } from "express";

export const runtimeConfigMiddleware = (uiPath: string, networkId: string) => {
  // uiPath is operator configuration, not request input; the fixed filename
  // cannot escape that configured directory.
  const indexFile = path.join(uiPath, "index.html"); // nosemgrep
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path !== "/" && !req.path.match(/^\/index\.html$/)) return next();
    fs.readFile(indexFile, "utf8", (err, html) => {
      if (err) return next(err);
      const injected = html.replace(
        "</head>",
        `<script>window.__APP_CONFIG__ = ${JSON.stringify({ networkId })};</script></head>`,
      );
      res.setHeader("Content-Type", "text/html");
      res.send(injected);
    });
  };
};
