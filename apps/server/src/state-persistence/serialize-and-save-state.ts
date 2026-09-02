import pino from "pino";
import { StateContext } from "../composition-root.js";

export const saveState = ({
  shieldedState,
  unshieldedState,
  dustState,
  stateContext,
  logger,
}: {
  shieldedState: string;
  unshieldedState: string;
  dustState: string;
  stateContext: StateContext;
  logger: pino.Logger;
}) =>
  stateContext.stateSnapshots.saveState({
    logger,
    shielded: shieldedState,
    unshielded: unshieldedState,
    dust: dustState,
  });
