import { StateContext } from "../composition-root.js";
import { encryptData } from "./encryption.js";

export const saveState = ({
  shieldedState,
  unshieldedState,
  dustState,
  stateContext,
  encryptionKey,
}: {
  shieldedState: string;
  unshieldedState: string;
  dustState: string;
  stateContext: StateContext;
  encryptionKey: Buffer;
}) => {
  const encryptedShieldedSerializedState = encryptData(encryptionKey, shieldedState);
  const encryptedUnshieldedSerializedState = encryptData(encryptionKey, unshieldedState);
  const encryptedDustSerializedState = encryptData(encryptionKey, dustState);

  return stateContext.stateSnapshots.saveState({
    shielded: encryptedShieldedSerializedState,
    unshielded: encryptedUnshieldedSerializedState,
    dust: encryptedDustSerializedState,
  });
};
