import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import * as express from "express";
import * as http from "node:http";
import pino from "pino";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import {
  createDripRoutes,
  livenessFailureReason,
  mkClearStateForRestart,
  CLEAR_STATE_MAX_ATTEMPTS,
  type DripRouteDeps,
} from "../drip-routes.js";
import type { CheckStatus, HealthService } from "../../health.js";
import { statePersistenceStatus } from "../../metrics/index.js";
import type { PostgresqlStateSnapshotsRepository } from "../../state-persistence/state-persistence-repository.js";

const logger = pino({ level: "silent" });

type Truncate = (logger: pino.Logger) => Promise<void>;
type StateSnapshotsStub = { truncate: Mock<Truncate> };

const truncateMock = (): Mock<Truncate> => vi.fn<Truncate>();

const makeStateSnapshots = (): StateSnapshotsStub => ({
  truncate: truncateMock().mockResolvedValue(undefined),
});

type CheckResultStub = { status: CheckStatus; details: Record<string, CheckStatus> };

const makeDeps = (opts: {
  needsRestart: boolean;
  connectivity: "ok" | "not_ok";
  stateSnapshots: StateSnapshotsStub;
  checks?: Partial<Record<"liveness" | "readiness" | "connectivity", CheckResultStub>>;
}): DripRouteDeps => ({
  // Only /health is exercised here, so the request-path dependencies are unused.
  taskManager: {} as DripRouteDeps["taskManager"],
  taskRepository: {} as DripRouteDeps["taskRepository"],
  // Type cast required because: the route only ever calls `truncate`, and
  // constructing a real repository would need a live knex connection.
  stateSnapshots: opts.stateSnapshots as unknown as PostgresqlStateSnapshotsRepository,
  healthService: {
    doChecks: vi
      .fn()
      .mockImplementation((key: "liveness" | "readiness" | "connectivity") =>
        Promise.resolve(
          opts.checks?.[key] ??
            (key === "connectivity"
              ? { status: opts.connectivity, details: {} }
              : { status: "ok", details: {} }),
        ),
      ),
  } as unknown as HealthService<"liveness" | "readiness" | "connectivity">,
  syncStuckDetector: {
    needsRestart: opts.needsRestart,
    start: vi.fn(),
    stop: vi.fn(),
    check: vi.fn<() => Promise<void>>(),
  },
  logger,
  networkId: NetworkId.NetworkId.Undeployed,
  maxAmount: 1000,
});

describe("GET /health — state clearing on restart signal", () => {
  let server: http.Server;
  let baseUrl: string;

  const listen = (deps: DripRouteDeps): Promise<void> => {
    const app = express.default();
    app.use(createDripRoutes(deps));
    return new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  };

  const getHealth = async (): Promise<{ status: number; body: { reason: string | null } }> => {
    const response = await fetch(`${baseUrl}/health`);
    return { status: response.status, body: (await response.json()) as { reason: string | null } };
  };

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("clears state_snapshots once, however many times the probe is polled", async () => {
    const stateSnapshots = makeStateSnapshots();
    await listen(makeDeps({ needsRestart: true, connectivity: "ok", stateSnapshots }));

    const first = await getHealth();
    await getHealth();
    await getHealth();

    expect(first.status).toBe(503);
    expect(first.body.reason).toBe("SYNC_STUCK_RECOVERY");
    expect(stateSnapshots.truncate).toHaveBeenCalledTimes(1);
  });

  it("does not clear anything while the detector is not signalling a restart", async () => {
    const stateSnapshots = makeStateSnapshots();
    await listen(makeDeps({ needsRestart: false, connectivity: "ok", stateSnapshots }));

    await getHealth();

    expect(stateSnapshots.truncate).not.toHaveBeenCalled();
  });

  it("clears even when connectivity is down and SERVICES_DOWN wins the response", async () => {
    const stateSnapshots = makeStateSnapshots();
    await listen(makeDeps({ needsRestart: true, connectivity: "not_ok", stateSnapshots }));

    const response = await getHealth();

    expect(response.status).toBe(503);
    expect(response.body.reason).toBe("SERVICES_DOWN");
    expect(stateSnapshots.truncate).toHaveBeenCalledTimes(1);
  });

  it("still reports the restart signal when the clear fails", async () => {
    const stateSnapshots: StateSnapshotsStub = {
      truncate: truncateMock().mockRejectedValue(new Error("db gone")),
    };
    await listen(makeDeps({ needsRestart: true, connectivity: "ok", stateSnapshots }));

    const response = await getHealth();

    expect(response.status).toBe(503);
    expect(response.body.reason).toBe("SYNC_STUCK_RECOVERY");
  });
});

describe("GET /health — liveness failure reasons", () => {
  let server: http.Server;
  let baseUrl: string;

  const listen = (deps: DripRouteDeps): Promise<void> => {
    const app = express.default();
    app.use(createDripRoutes(deps));
    return new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  };

  const getHealth = async (): Promise<{ status: number; body: { reason: string | null } }> => {
    const response = await fetch(`${baseUrl}/health`);
    return { status: response.status, body: (await response.json()) as { reason: string | null } };
  };

  const listenWithLiveness = (details: Record<string, CheckStatus>): Promise<void> =>
    listen(
      makeDeps({
        needsRestart: false,
        connectivity: "ok",
        stateSnapshots: makeStateSnapshots(),
        checks: { liveness: { status: "not_ok", details } },
      }),
    );

  beforeEach(() => {
    // The persistence branch sits ahead of liveness in the health ladder;
    // pin it healthy so these tests exercise the liveness branch.
    statePersistenceStatus.set(1);
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("reports WALLET_BALANCE_LOW when the balance check is the one failing", async () => {
    await listenWithLiveness({ "faucet-wallet-sync": "ok", "faucet-wallet-balance": "not_ok" });

    const response = await getHealth();

    expect(response.status).toBe(503);
    expect(response.body.reason).toBe("WALLET_BALANCE_LOW");
  });

  it("does not blame the balance when the wallet has not started syncing", async () => {
    await listenWithLiveness({ "faucet-wallet-sync": "not_ok", "faucet-wallet-balance": "ok" });

    const response = await getHealth();

    expect(response.status).toBe(503);
    expect(response.body.reason).toBe("WALLET_NOT_SYNCED");
  });

  it("falls back to a generic reason for an unrecognised liveness failure", async () => {
    await listenWithLiveness({ "some-future-check": "not_ok" });

    const response = await getHealth();

    expect(response.status).toBe(503);
    expect(response.body.reason).toBe("LIVENESS_CHECK_FAILED");
  });
});

describe("livenessFailureReason", () => {
  it("prefers the sync reason when both checks fail, since no balance reading is trustworthy then", () => {
    expect(
      livenessFailureReason({ "faucet-wallet-sync": "not_ok", "faucet-wallet-balance": "not_ok" }),
    ).toBe("WALLET_NOT_SYNCED");
  });

  it("reports the balance reason only when sync is healthy", () => {
    expect(
      livenessFailureReason({ "faucet-wallet-sync": "ok", "faucet-wallet-balance": "not_ok" }),
    ).toBe("WALLET_BALANCE_LOW");
  });

  it("reports the sync reason when only sync fails", () => {
    expect(
      livenessFailureReason({ "faucet-wallet-sync": "not_ok", "faucet-wallet-balance": "ok" }),
    ).toBe("WALLET_NOT_SYNCED");
  });

  it("is generic when no known check failed", () => {
    expect(livenessFailureReason({})).toBe("LIVENESS_CHECK_FAILED");
    expect(livenessFailureReason({ "faucet-wallet-sync": "ok" })).toBe("LIVENESS_CHECK_FAILED");
  });
});

describe("mkClearStateForRestart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("truncates once across repeated calls", async () => {
    const stateSnapshots = makeStateSnapshots();
    const clear = mkClearStateForRestart(stateSnapshots, logger);

    await clear();
    await clear();
    await clear();

    expect(stateSnapshots.truncate).toHaveBeenCalledTimes(1);
  });

  it("shares a single truncate between concurrent callers", async () => {
    const stateSnapshots = makeStateSnapshots();
    const clear = mkClearStateForRestart(stateSnapshots, logger);

    await Promise.all([clear(), clear(), clear()]);

    expect(stateSnapshots.truncate).toHaveBeenCalledTimes(1);
  });

  it("retries a failing truncate but stops at the attempt cap", async () => {
    const stateSnapshots: StateSnapshotsStub = {
      truncate: truncateMock().mockRejectedValue(new Error("db gone")),
    };
    const clear = mkClearStateForRestart(stateSnapshots, logger);

    // Poll well beyond the cap — a failing DB must not mean a TRUNCATE per poll.
    const polls = Array.from({ length: CLEAR_STATE_MAX_ATTEMPTS + 5 });
    await polls.reduce<Promise<void>>(
      (previous) => previous.then(() => clear()),
      Promise.resolve(),
    );

    expect(stateSnapshots.truncate).toHaveBeenCalledTimes(CLEAR_STATE_MAX_ATTEMPTS);
  });

  it("never rejects, so the health probe is unaffected by a failing clear", async () => {
    const stateSnapshots: StateSnapshotsStub = {
      truncate: truncateMock().mockRejectedValue(new Error("db gone")),
    };
    const clear = mkClearStateForRestart(stateSnapshots, logger);

    await expect(clear()).resolves.toBeUndefined();
  });

  it("succeeds on a later attempt once the DB recovers", async () => {
    const stateSnapshots: StateSnapshotsStub = {
      truncate: truncateMock()
        .mockRejectedValueOnce(new Error("db gone"))
        .mockResolvedValue(undefined),
    };
    const clear = mkClearStateForRestart(stateSnapshots, logger);

    await clear();
    await clear();
    await clear();

    expect(stateSnapshots.truncate).toHaveBeenCalledTimes(2);
  });
});
