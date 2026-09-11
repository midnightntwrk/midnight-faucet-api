/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Subject } from "rxjs";
import pino from "pino";
import { FaucetState } from "@midnightntwrk/faucet-internal-api";
import { createSyncStuckDetector } from "../sync-stuck-detector.js";
import { HealthService } from "../health.js";
import { PostgresqlStateSnapshotsRepository } from "../state-persistence/state-persistence-repository.js";

const logger = pino({ level: "silent" });

const makeHealthService = (connectivityStatus: "ok" | "not_ok" = "ok") => {
  const doChecks = vi.fn().mockResolvedValue({
    status: connectivityStatus,
    details: {},
  });
  return { doChecks } as unknown as HealthService<"liveness" | "readiness" | "connectivity">;
};

const makeStateSnapshots = () => {
  const truncate = vi.fn().mockResolvedValue(undefined);
  return { truncate } as unknown as PostgresqlStateSnapshotsRepository;
};

const makeState$ = () => new Subject<FaucetState>();

const emitState = (state$: Subject<FaucetState>, appliedId: bigint, highestTxId: bigint) => {
  state$.next({
    unshielded: {
      syncProgress: { appliedId, highestTransactionId: highestTxId, isConnected: true },
      isSynced: false,
      availableBalance: 0n,
      availableCoins: [],
      totalCoins: [],
      pendingCoins: [],
    },
    shielded: {
      isSynced: false,
      availableBalance: 0n,
      availableCoins: [],
      totalCoins: [],
      pendingCoins: [],
      syncProgress: {
        appliedIndex: 0n,
        highestRelevantWalletIndex: 0n,
        highestIndex: 0n,
        highestRelevantIndex: 0n,
        isConnected: true,
      },
    },
    dust: {
      isSynced: false,
      availableBalance: 0n,
      availableCoins: [],
      totalCoins: [],
      pendingCoins: [],
      syncProgress: {
        appliedIndex: 0n,
        highestRelevantWalletIndex: 0n,
        highestIndex: 0n,
        highestRelevantIndex: 0n,
        isConnected: true,
      },
    },
  } as unknown as FaucetState);
};

const defaultConfig = {
  errorThresholdMs: 100,
  stallThresholdMs: 200,
  checkIntervalMs: 50,
  hygieneTruncateMs: 10_000,
};

describe("SyncStuckDetector", () => {
  let syncErrors$: Subject<unknown>;
  let state$: Subject<FaucetState>;
  let detector: ReturnType<typeof createSyncStuckDetector>;

  beforeEach(() => {
    syncErrors$ = new Subject<unknown>();
    state$ = makeState$();
    vi.useFakeTimers();
  });

  afterEach(() => {
    detector?.stop();
    vi.useRealTimers();
  });

  describe("corrupted state errors", () => {
    it("does nothing when no errors are emitted", async () => {
      const healthService = makeHealthService();
      const stateSnapshots = makeStateSnapshots();
      detector = createSyncStuckDetector(
        syncErrors$,
        state$,
        healthService,
        stateSnapshots,
        logger,
        defaultConfig,
      );

      detector.start();
      await detector.check();

      expect(detector.needsRestart).toBe(false);
      expect(stateSnapshots.truncate).not.toHaveBeenCalled();
    });

    it("does not truncate before threshold elapsed", async () => {
      const healthService = makeHealthService();
      const stateSnapshots = makeStateSnapshots();
      detector = createSyncStuckDetector(
        syncErrors$,
        state$,
        healthService,
        stateSnapshots,
        logger,
        {
          ...defaultConfig,
          errorThresholdMs: 10_000,
        },
      );

      detector.start();
      syncErrors$.next({ _tag: "Wallet.Other" });

      vi.advanceTimersByTime(1_000);
      await detector.check();

      expect(detector.needsRestart).toBe(false);
      expect(stateSnapshots.truncate).not.toHaveBeenCalled();
    });

    it("truncates and sets needsRestart after threshold with good connectivity", async () => {
      const healthService = makeHealthService("ok");
      const stateSnapshots = makeStateSnapshots();
      detector = createSyncStuckDetector(
        syncErrors$,
        state$,
        healthService,
        stateSnapshots,
        logger,
        defaultConfig,
      );

      detector.start();
      syncErrors$.next({ _tag: "Wallet.Other" });

      vi.advanceTimersByTime(200);
      await detector.check();

      expect(stateSnapshots.truncate).toHaveBeenCalledWith(logger);
      expect(detector.needsRestart).toBe(true);
    });

    it("resets timer when connectivity is not OK", async () => {
      const healthService = makeHealthService("not_ok");
      const stateSnapshots = makeStateSnapshots();
      detector = createSyncStuckDetector(
        syncErrors$,
        state$,
        healthService,
        stateSnapshots,
        logger,
        defaultConfig,
      );

      detector.start();
      syncErrors$.next({ _tag: "Wallet.Other" });

      vi.advanceTimersByTime(200);
      await detector.check();

      expect(stateSnapshots.truncate).not.toHaveBeenCalled();
      expect(detector.needsRestart).toBe(false);

      healthService.doChecks = vi.fn().mockResolvedValue({ status: "ok", details: {} });

      await detector.check();
      expect(detector.needsRestart).toBe(false);
    });

    it("does not truncate again once needsRestart is set", async () => {
      const healthService = makeHealthService("ok");
      const stateSnapshots = makeStateSnapshots();
      detector = createSyncStuckDetector(
        syncErrors$,
        state$,
        healthService,
        stateSnapshots,
        logger,
        defaultConfig,
      );

      detector.start();
      syncErrors$.next({ _tag: "Wallet.Other" });

      vi.advanceTimersByTime(200);
      await vi.advanceTimersByTimeAsync(0);
      const callCountAfterFirst = vi.mocked(stateSnapshots.truncate).mock.calls.length;
      expect(callCountAfterFirst).toBeGreaterThanOrEqual(1);
      expect(detector.needsRestart).toBe(true);

      syncErrors$.next({ _tag: "Wallet.Other" });
      vi.advanceTimersByTime(200);
      await vi.advanceTimersByTimeAsync(0);

      expect(stateSnapshots.truncate).toHaveBeenCalledTimes(callCountAfterFirst);
      expect(detector.needsRestart).toBe(true);
    });

    it("handles truncate failure gracefully", async () => {
      const healthService = makeHealthService("ok");
      const stateSnapshots = makeStateSnapshots();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      stateSnapshots.truncate = vi.fn().mockRejectedValue(new Error("DB error")) as any;
      detector = createSyncStuckDetector(
        syncErrors$,
        state$,
        healthService,
        stateSnapshots,
        logger,
        defaultConfig,
      );

      detector.start();
      syncErrors$.next({ _tag: "Wallet.Other" });

      vi.advanceTimersByTime(200);
      await detector.check();

      expect(stateSnapshots.truncate).toHaveBeenCalled();
      expect(detector.needsRestart).toBe(false);
    });

    it("only records firstErrorTime on the first error", async () => {
      const healthService = makeHealthService("ok");
      const stateSnapshots = makeStateSnapshots();
      detector = createSyncStuckDetector(
        syncErrors$,
        state$,
        healthService,
        stateSnapshots,
        logger,
        {
          ...defaultConfig,
          errorThresholdMs: 500,
        },
      );

      detector.start();
      syncErrors$.next("error-1");

      vi.advanceTimersByTime(200);
      syncErrors$.next("error-2");

      vi.advanceTimersByTime(300);
      await detector.check();

      expect(stateSnapshots.truncate).toHaveBeenCalled();
      expect(detector.needsRestart).toBe(true);
    });
  });

  describe("stalled sync progress", () => {
    it("triggers recovery when appliedId stalls with a large gap", async () => {
      const healthService = makeHealthService("ok");
      const stateSnapshots = makeStateSnapshots();
      detector = createSyncStuckDetector(
        syncErrors$,
        state$,
        healthService,
        stateSnapshots,
        logger,
        defaultConfig,
      );

      detector.start();

      // Emit state with a gap > 200
      emitState(state$, 100n, 500n);

      // Wait beyond stall threshold
      vi.advanceTimersByTime(300);
      await detector.check();

      expect(stateSnapshots.truncate).toHaveBeenCalledWith(logger);
      expect(detector.needsRestart).toBe(true);
    });

    it("does not trigger when appliedId is progressing", async () => {
      const healthService = makeHealthService("ok");
      const stateSnapshots = makeStateSnapshots();
      detector = createSyncStuckDetector(
        syncErrors$,
        state$,
        healthService,
        stateSnapshots,
        logger,
        defaultConfig,
      );

      detector.start();

      emitState(state$, 100n, 500n);
      vi.advanceTimersByTime(100);

      // Progress is made
      emitState(state$, 200n, 500n);
      vi.advanceTimersByTime(100);

      // More progress
      emitState(state$, 300n, 500n);
      vi.advanceTimersByTime(100);

      await detector.check();

      expect(stateSnapshots.truncate).not.toHaveBeenCalled();
      expect(detector.needsRestart).toBe(false);
    });

    it("does not trigger when gap is small", async () => {
      const healthService = makeHealthService("ok");
      const stateSnapshots = makeStateSnapshots();
      detector = createSyncStuckDetector(
        syncErrors$,
        state$,
        healthService,
        stateSnapshots,
        logger,
        defaultConfig,
      );

      detector.start();

      // Gap is only 50 (< 200 threshold)
      emitState(state$, 450n, 500n);

      vi.advanceTimersByTime(300);
      await detector.check();

      expect(stateSnapshots.truncate).not.toHaveBeenCalled();
      expect(detector.needsRestart).toBe(false);
    });

    it("resets stall timer during connectivity issues", async () => {
      const healthService = makeHealthService("not_ok");
      const stateSnapshots = makeStateSnapshots();
      detector = createSyncStuckDetector(
        syncErrors$,
        state$,
        healthService,
        stateSnapshots,
        logger,
        defaultConfig,
      );

      detector.start();

      emitState(state$, 100n, 500n);
      vi.advanceTimersByTime(300);
      await detector.check();

      // Should not trigger — connectivity is down, stall timer is reset
      expect(stateSnapshots.truncate).not.toHaveBeenCalled();
      expect(detector.needsRestart).toBe(false);

      // Connectivity recovers — needs another full stall threshold
      healthService.doChecks = vi.fn().mockResolvedValue({ status: "ok", details: {} });
      await detector.check();

      expect(detector.needsRestart).toBe(false);
    });

    it("does not trigger before stall threshold", async () => {
      const healthService = makeHealthService("ok");
      const stateSnapshots = makeStateSnapshots();
      detector = createSyncStuckDetector(
        syncErrors$,
        state$,
        healthService,
        stateSnapshots,
        logger,
        {
          ...defaultConfig,
          stallThresholdMs: 10_000,
        },
      );

      detector.start();

      emitState(state$, 100n, 500n);
      vi.advanceTimersByTime(1_000);
      await detector.check();

      expect(detector.needsRestart).toBe(false);
      expect(stateSnapshots.truncate).not.toHaveBeenCalled();
    });
  });

  describe("hygiene truncate", () => {
    it("triggers recovery after hygieneTruncateMs of uptime", async () => {
      const healthService = makeHealthService("ok");
      const stateSnapshots = makeStateSnapshots();
      detector = createSyncStuckDetector(
        syncErrors$,
        state$,
        healthService,
        stateSnapshots,
        logger,
        {
          ...defaultConfig,
          hygieneTruncateMs: 500,
        },
      );

      detector.start();

      vi.advanceTimersByTime(499);
      await detector.check();
      expect(detector.needsRestart).toBe(false);

      vi.advanceTimersByTime(1);
      await detector.check();
      expect(stateSnapshots.truncate).toHaveBeenCalledWith(logger);
      expect(detector.needsRestart).toBe(true);
    });

    it("does not trigger before hygieneTruncateMs", async () => {
      const healthService = makeHealthService("ok");
      const stateSnapshots = makeStateSnapshots();
      detector = createSyncStuckDetector(
        syncErrors$,
        state$,
        healthService,
        stateSnapshots,
        logger,
        defaultConfig,
      );

      detector.start();

      vi.advanceTimersByTime(5_000);
      await detector.check();

      expect(stateSnapshots.truncate).not.toHaveBeenCalled();
      expect(detector.needsRestart).toBe(false);
    });
  });

  it("stop() unsubscribes and clears interval", () => {
    const healthService = makeHealthService();
    const stateSnapshots = makeStateSnapshots();
    detector = createSyncStuckDetector(
      syncErrors$,
      state$,
      healthService,
      stateSnapshots,
      logger,
      defaultConfig,
    );

    detector.start();
    detector.stop();

    syncErrors$.next("error");
    emitState(state$, 100n, 500n);
    expect(detector.needsRestart).toBe(false);
  });
});
