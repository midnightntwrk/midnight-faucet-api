import pino from "pino";
import { StateContext } from "../composition-root.js";
import { statePersistenceStatus } from "../metrics/index.js";
import { saveState as defaultSaveState } from "./serialize-and-save-state.js";

export type SerializedWalletState = {
  shielded: Promise<string>;
  unshielded: Promise<string>;
  dust: Promise<string>;
};

/**
 * One tick of the snapshot loop, lifted out of the `server.ts` closure so the
 * gauge it drives can be tested (#77). `statePersistenceStatus` is the only
 * thing standing between a failed write and STATE_PERSISTENCE_FAILURE on the
 * health routes, so the 1/0 transitions here are the behaviour under test —
 * `saveState` is injected to drive them without a database.
 */
export const mkPersistWalletState =
  ({
    serializeWalletState,
    syncStuckDetector,
    stateContext,
    encryptionKey,
    logger,
    saveState = defaultSaveState,
  }: {
    serializeWalletState: () => SerializedWalletState;
    syncStuckDetector: { readonly needsRestart: boolean };
    stateContext: StateContext;
    encryptionKey: Buffer;
    logger: pino.Logger;
    saveState?: typeof defaultSaveState;
  }) =>
  async (): Promise<void> => {
    if (syncStuckDetector.needsRestart) {
      logger.warn("Skipping state persistence — sync stuck recovery in progress");
      return;
    }

    try {
      // Serializing is inside the `try` because those promises can reject on a
      // wallet mid-resync, and the caller fire-and-forgets this function — an
      // escaping rejection would leave the gauge frozen at its last value,
      // which is the #77 failure mode one layer up.
      const state = serializeWalletState();

      await saveState({
        shieldedState: await state.shielded,
        unshieldedState: await state.unshielded,
        dustState: await state.dust,
        stateContext,
        encryptionKey,
      });
      statePersistenceStatus.set(1);
    } catch (error) {
      statePersistenceStatus.set(0);
      logger.error({ err: error }, "Failed to persist wallet state");
    }
  };
