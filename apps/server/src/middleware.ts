import fs from "fs";
import { pathToFileURL } from "node:url";
import type { Request, Response, NextFunction } from "express";

export const runtimeConfigMiddleware = (uiPath: string, networkId: string) => {
  const uiDirectory = pathToFileURL(uiPath.endsWith("/") ? uiPath : `${uiPath}/`);
  const indexFile = new URL("index.html", uiDirectory);
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
