import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkPersistWalletState } from "../persist-wallet-state.js";
import { statePersistenceStatus } from "../../metrics/index.js";
import type { StateContext } from "../../composition-root.js";
import type { saveState } from "../serialize-and-save-state.js";

const gauge = async (): Promise<number | undefined> =>
  (await statePersistenceStatus.get()).values[0]?.value;

const serializedState = () => ({
  shielded: Promise.resolve("shielded"),
  unshielded: Promise.resolve("unshielded"),
  dust: Promise.resolve("dust"),
});

const persistWith = ({
  needsRestart = false,
  save = vi.fn<typeof saveState>().mockResolvedValue({ id: 1 }),
  serializeWalletState = serializedState,
  logger = pino({ level: "silent" }),
}: {
  needsRestart?: boolean;
  save?: ReturnType<typeof vi.fn<typeof saveState>>;
  serializeWalletState?: () => ReturnType<typeof serializedState>;
  logger?: pino.Logger;
} = {}) => ({
  save,
  persist: mkPersistWalletState({
    serializeWalletState,
    syncStuckDetector: { needsRestart },
    // Type cast required because: `saveState` is injected, so the repositories
    // on the context are never reached.
    stateContext: {} as StateContext,
    encryptionKey: Buffer.alloc(32),
    logger,
    saveState: save,
  }),
});

describe("persistWalletState", () => {
  afterEach(() => {
    statePersistenceStatus.set(1);
  });

  it("marks persistence healthy after a successful write", async () => {
    statePersistenceStatus.set(0);
    const { persist, save } = persistWith();

    await persist();

    expect(save).toHaveBeenCalledTimes(1);
    expect(await gauge()).toBe(1);
  });

  it("drops the gauge to 0 when the write rejects, so /health can report it", async () => {
    const failure = new Error("canceling statement due to statement timeout");
    const { persist } = persistWith({
      save: vi.fn<typeof saveState>().mockRejectedValue(failure),
    });

    await persist();

    expect(await gauge()).toBe(0);
  });

  it("logs the failed write once, under `err`", async () => {
    const failure = new Error("canceling statement due to statement timeout");
    const errorLog = vi.fn();
    const { persist } = persistWith({
      save: vi.fn<typeof saveState>().mockRejectedValue(failure),
      // Type cast required because: only `error` and `warn` are reached here.
      logger: { error: errorLog, warn: vi.fn() } as unknown as pino.Logger,
    });

    await persist();

    expect(errorLog).toHaveBeenCalledTimes(1);
    const [fields] = errorLog.mock.calls[0] as [{ err?: unknown }];
    expect(fields.err).toBe(failure);
  });

  // Serializing used to happen outside the try/catch, so a rejection escaped
  // the fire-and-forget caller and left the gauge at its previous value.
  it("drops the gauge to 0 when serializing the wallet rejects", async () => {
    const { persist, save } = persistWith({
      serializeWalletState: () => ({
        shielded: Promise.reject(new Error("wallet mid-resync")),
        unshielded: Promise.resolve("unshielded"),
        dust: Promise.resolve("dust"),
      }),
    });

    await expect(persist()).resolves.toBeUndefined();

    expect(save).not.toHaveBeenCalled();
    expect(await gauge()).toBe(0);
  });

  it("skips the write and leaves the gauge alone during sync stuck recovery", async () => {
    statePersistenceStatus.set(0);
    const { persist, save } = persistWith({ needsRestart: true });

    await persist();

    expect(save).not.toHaveBeenCalled();
    expect(await gauge()).toBe(0);
  });
});
