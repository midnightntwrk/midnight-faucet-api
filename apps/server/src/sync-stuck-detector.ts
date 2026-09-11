import { Observable, Subscription } from "rxjs";
import pino from "pino";
import { FaucetState } from "@midnightntwrk/faucet-internal-api";
import { HealthService } from "./health.js";
import { PostgresqlStateSnapshotsRepository } from "./state-persistence/state-persistence-repository.js";

export type SyncStuckDetectorConfig = {
  errorThresholdMs: number;
  stallThresholdMs: number;
  checkIntervalMs: number;
  hygieneTruncateMs: number;
};

const defaultConfig: SyncStuckDetectorConfig = {
  errorThresholdMs: 3 * 60 * 1000, // 3 minutes
  stallThresholdMs: 5 * 60 * 1000, // 5 minutes
  checkIntervalMs: 30 * 1000, // 30 seconds
  hygieneTruncateMs: 42 * 60 * 60 * 1000, // 42 hours
};

export type SyncStuckDetector = {
  start: () => void;
  stop: () => void;
  readonly needsRestart: boolean;
  /** Trigger a check immediately (useful for testing) */
  check: () => Promise<void>;
};

export const createSyncStuckDetector = (
  syncErrors$: Observable<unknown>,
  state$: Observable<FaucetState>,
  healthService: HealthService<"liveness" | "readiness" | "connectivity">,
  stateSnapshots: PostgresqlStateSnapshotsRepository,
  logger: pino.Logger,
  config: SyncStuckDetectorConfig = defaultConfig,
): SyncStuckDetector => {
  let needsRestart = false;
  let firstErrorTime: number | null = null;
  let errorSubscription: Subscription | null = null;
  let stateSubscription: Subscription | null = null;
  let checkIntervalId: ReturnType<typeof setInterval> | null = null;
  let startTime: number | null = null;

  // Stall detection: track last seen appliedId and when it last changed
  let lastAppliedId: bigint | null = null;
  let lastProgressTime: number | null = null;
  let lastHighestTxId: bigint | null = null;

  const dumpStateBeforeTruncate = async (): Promise<void> => {
    try {
      const snapshot = await stateSnapshots.getState(logger);
      if (snapshot) {
        logger.warn(
          {
            snapshotId: snapshot.id,
            createdAt: snapshot.created_at,
            shielded: snapshot.shielded,
            unshielded: snapshot.unshielded,
            dust: snapshot.dust,
          },
          "Dumping encrypted state snapshot before truncate — use encryption key to decrypt",
        );
      } else {
        logger.warn("No state snapshot found to dump before truncate");
      }
    } catch (error) {
      logger.error({ error }, "Failed to dump state snapshot before truncate");
    }
  };

  const triggerRecovery = async (reason: string): Promise<void> => {
    logger.warn({ reason }, "Triggering sync recovery — truncating state_snapshots");
    try {
      await dumpStateBeforeTruncate();
      await stateSnapshots.truncate(logger);
      needsRestart = true;
    } catch (error) {
      logger.error({ error }, "Failed to truncate state_snapshots");
    }
  };

  const check = async (): Promise<void> => {
    if (needsRestart) return;

    const connectivity = await healthService.doChecks("connectivity");

    // Check corrupted state errors (original logic)
    if (firstErrorTime !== null) {
      if (connectivity.status !== "ok") {
        logger.info("Connectivity not OK, resetting sync error timer");
        firstErrorTime = null;
      } else {
        const elapsed = Date.now() - firstErrorTime;
        if (elapsed >= config.errorThresholdMs) {
          await triggerRecovery("Sync errors persisted beyond threshold with good connectivity");
          return;
        }
      }
    }

    // Check stalled sync progress
    if (lastProgressTime !== null && lastHighestTxId !== null && lastAppliedId !== null) {
      if (connectivity.status !== "ok") {
        // Reset stall timer during connectivity issues
        lastProgressTime = Date.now();
        return;
      }

      const gap = lastHighestTxId - lastAppliedId;
      const stallDuration = Date.now() - lastProgressTime;

      if (gap > 200n && stallDuration >= config.stallThresholdMs) {
        await triggerRecovery(
          `Sync progress stalled for ${Math.round(stallDuration / 1000)}s with gap ${gap}`,
        );
        return;
      }
    }

    // Periodic hygiene truncate to reclaim disk space from dead tuples
    if (startTime !== null) {
      const uptime = Date.now() - startTime;
      if (uptime >= config.hygieneTruncateMs) {
        await triggerRecovery(
          `Scheduled hygiene truncate after ${Math.round(uptime / 3_600_000)}h of uptime`,
        );
      }
    }
  };

  return {
    get needsRestart() {
      return needsRestart;
    },

    check,

    start() {
      startTime = Date.now();

      errorSubscription = syncErrors$.subscribe({
        next: () => {
          if (firstErrorTime === null) {
            firstErrorTime = Date.now();
            logger.warn("Corrupted wallet state detected, starting recovery timer");
          }
        },
      });

      stateSubscription = state$.subscribe({
        next: (state) => {
          const { unshielded } = state;
          if (!unshielded.syncProgress) return;

          const currentAppliedId = unshielded.syncProgress.appliedId;
          const currentHighestTxId = unshielded.syncProgress.highestTransactionId;

          if (lastAppliedId === null || currentAppliedId !== lastAppliedId) {
            // Progress is being made — reset the stall timer
            lastProgressTime = Date.now();
          }

          lastAppliedId = currentAppliedId;
          lastHighestTxId = currentHighestTxId;
        },
      });

      checkIntervalId = setInterval(() => {
        void check();
      }, config.checkIntervalMs);
    },

    stop() {
      errorSubscription?.unsubscribe();
      errorSubscription = null;
      stateSubscription?.unsubscribe();
      stateSubscription = null;
      if (checkIntervalId !== null) {
        clearInterval(checkIntervalId);
        checkIntervalId = null;
      }
    },
  };
};
