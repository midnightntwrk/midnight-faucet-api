import pino from "pino";
import { StateContext } from "../composition-root.js";
import { encryptData } from "./encryption.js";

export const saveState = ({
  shieldedState,
  unshieldedState,
  dustState,
  stateContext,
  logger,
  encryptionKey,
}: {
  shieldedState: string;
  unshieldedState: string;
  dustState: string;
  stateContext: StateContext;
  logger: pino.Logger;
  encryptionKey: Buffer;
}) => {
  const encryptedShieldedSerializedState = encryptData(encryptionKey, shieldedState);
  const encryptedUnshieldedSerializedState = encryptData(encryptionKey, unshieldedState);
  const encryptedDustSerializedState = encryptData(encryptionKey, dustState);

  return stateContext.stateSnapshots.saveState({
    logger,
    shielded: encryptedShieldedSerializedState,
    unshielded: encryptedUnshieldedSerializedState,
    dust: encryptedDustSerializedState,
  });
};
