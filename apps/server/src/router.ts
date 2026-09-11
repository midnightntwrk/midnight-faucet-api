import { AuthenticatedUser } from "@midnightntwrk/faucet-auth";
import { Task } from "@midnightntwrk/faucet-utils";
import cors from "cors";
import * as express from "express";
import _ from "lodash";
import { CompositionRoot } from "./composition-root.js";
import { apiHttpRequestTimer } from "./metrics/http/index.js";
import { ServerConfig } from "./config.js";
import { CloudflareTurnstileVerifier } from "./captcha-verifier.js";
import { runtimeConfigMiddleware } from "./middleware.js";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import { thirdPartyRouter } from "./third-party/router.js";
import { createDripRoutes, type DripRouteDeps } from "./api/drip-routes.js";

export const metricsAppRouter = (deps: CompositionRoot) => {
  const router: express.Router = express.Router();

  router.use(express.json());

  router.get("/metrics", (req, res) => {
    if (req.accepts("text")) {
      res.setHeader("Content-Type", "text/plain");
      deps.metricsRegistry
        .metrics()
        .then((metrics) => res.status(200).send(metrics))
        .catch(() => res.status(500).send("Error retrieving metrics"));
      return;
    }

    if (req.accepts("json")) {
      deps.metricsRegistry
        .getMetricsAsJSON()
        .then((metrics) => res.status(200).json(metrics))
        .catch(() => res.status(500).send("Error retrieving metrics"));
      return;
    }

    res.status(400).send("Unsupported Media Type");
  });

  return router;
};

export const apiRouter = (
  deps: CompositionRoot,
  captchaSecretKey: string,
  captchaHeader: string,
  networkId: NetworkId.NetworkId,
  dropAmount: bigint,
) => {
  const BaseApiUrlRegExp = /(?<url>\/api\/[^\s/?]+)/;
  const router: express.Router = express.Router();
  const captchaVerifier = new CloudflareTurnstileVerifier(captchaSecretKey, captchaHeader);

  router.use(express.json());

  // HTTP request timing middleware
  router.use((req, res, next) => {
    const reqCtx = _.pick(req, "method", "originalUrl", "params");
    const timer = apiHttpRequestTimer.startTimer();
    deps.logger.trace(reqCtx, "Received request");
    res.once("finish", () => {
      deps.logger.debug(
        {
          ...reqCtx,
          ..._.pick(res, "statusCode"),
        },
        "Request served",
      );

      timer({
        method: reqCtx.method,
        originalUrl: BaseApiUrlRegExp.exec(reqCtx.originalUrl)!.groups!.url,
      });
    });
    return next();
  });

  // Captcha verification middleware — only applies to POST /drips
  router.post("/drips", async (req, res, next) => {
    const captchaToken = req.headers["x-captcha-token"] as string | undefined;
    if (!captchaToken) {
      return res.status(400).json({ error: "Missing X-Captcha-Token header" });
    }

    try {
      await Task.unsafeRun(captchaVerifier.verify(captchaToken, req.headers["x-turnstile-token"]));
      next();
    } catch (error) {
      deps.logger.error({ err: error }, "Captcha verification failed");
      res.status(403).json({ error: "Captcha verification failed" });
    }
  });

  // Shared drip routes (POST /drips, GET /drips/:dripId, GET /health)
  const TNIGHT_UNIT = 5_000_000n;
  const dripDeps: DripRouteDeps = {
    taskManager: deps.taskManager,
    taskRepository: deps.stateContext.taskRepository,
    stateSnapshots: deps.stateContext.stateSnapshots,
    healthService: deps.healthService,
    syncStuckDetector: deps.syncStuckDetector,
    logger: deps.logger,
    networkId,
    maxAmount: Number(dropAmount / TNIGHT_UNIT),
  };
  router.use(createDripRoutes(dripDeps));

  router.get("/ready", (_req, res) => {
    deps.healthService
      .doChecks("readiness")
      .then((status) => {
        switch (status.status) {
          case "ok":
            res.status(200).json(status);
            break;
          case "not_ok":
            res.status(503).json(status);
            break;
        }
      })
      .catch(() => {
        res.status(500).json({ error: "Internal server error" });
      });
  });

  return router;
};

export const appRouter = (config: ServerConfig, root: CompositionRoot): express.Router => {
  const api = apiRouter(
    root,
    config.turnstileKey,
    config.turnstileHeader,
    config.networkId,
    BigInt(config.dropAmount),
  );
  const v1 = thirdPartyRouter({
    config: config.thirdPartyApi,
    taskManager: root.taskManager,
    taskRepository: root.stateContext.taskRepository,
    stateSnapshots: root.stateContext.stateSnapshots,
    healthService: root.healthService,
    syncStuckDetector: root.syncStuckDetector,
    logger: root.logger,
    networkId: config.networkId,
  });
  const ui = express.static(config.uiPath);

  const router = express.Router();

  router.use(runtimeConfigMiddleware(config.uiPath, String(config.networkId)));

  router.use(
    cors({
      origin: true,
      methods: ["GET", "POST"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Turnstile-Token",
        "X-Captcha-Token",
        "Strict-Transport-Security",
      ],
    }),
  );

  router.use(ui);
  router.use("/api", api);
  router.use("/v1", v1);
  router.use(
    (err: Error, req: express.Request, _res: express.Response, next: express.NextFunction) => {
      root.logger.error(
        {
          err,
          url: req.originalUrl,
          user: (req.user as AuthenticatedUser)?.user?.id?.value ?? null,
        },
        "Request error",
      );
      next(err);
    },
  );

  return router;
};
