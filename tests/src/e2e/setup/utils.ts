import { filter, firstValueFrom, tap, throttleTime, timeout } from "rxjs";
import * as path from "node:path";
import * as fsAsync from "node:fs/promises";
import pinoPretty from "pino-pretty";
import pino from "pino";
import { createWriteStream, existsSync } from "node:fs";
import { type DefaultConfiguration, WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { NoOpTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import { ShieldedWallet, type ShieldedWalletClass } from "@midnightntwrk/wallet-sdk-shielded";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { LedgerParameters } from "@midnightntwrk/ledger-v9";
import * as fs from "node:fs";
import { exit } from "node:process";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import { ShieldedAddress, UnshieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";
import { HDWallet, Roles } from "@midnightntwrk/wallet-sdk-hd";
import { qanetConstants } from "./Constants";
import { DevnetFaucetMainPage } from "../pages/DevnetFaucetMainPage";
import { Page } from "@playwright/test";

export const createLogger = async (logPath: string): Promise<pino.Logger> => {
  await fsAsync.mkdir(path.dirname(logPath), { recursive: true });
  const pretty: pinoPretty.PrettyStream = pinoPretty({
    colorize: true,
    sync: true,
  });
  const level = "trace" as const;
  return pino(
    {
      level,
      depthLimit: 20,
    },
    pino.multistream([
      { stream: pretty, level: "trace" },
      { stream: createWriteStream(logPath), level },
    ]),
  );
};

export const currentDir = path.resolve(new URL(import.meta.url).pathname, "..");
const logger = await createLogger(
  path.resolve(currentDir, "..", "logs", "utils", `${new Date().toISOString()}.log`),
);

export const buildWalletFacade = async (walletSeed: string, walletConfig: DefaultConfiguration) => {
  const unshieldedKeyStore = createKeystore(
    { kind: "schnorr", secret: getUnshieldedSeed(walletSeed) },
    walletConfig.networkId,
  );
  const Wallet = ShieldedWallet(walletConfig);

  const shieldedWallet = Wallet.startWithSeed(getShieldedSeed(walletSeed));

  const unshieldedWallet = UnshieldedWallet({
    ...walletConfig,
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
  }).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeyStore));

  const dustSeed = getDustSeed(walletSeed);
  const Dust = DustWallet(walletConfig);
  const dustParameters = LedgerParameters.initialParameters().dust;
  const dustWallet = Dust.startWithSeed(dustSeed, dustParameters);

  return WalletFacade.init({
    configuration: walletConfig,
    shielded: () => shieldedWallet,
    unshielded: () => unshieldedWallet,
    dust: () => dustWallet,
  });
};

const restoreShieldedWallet = async (
  path: string,
  Wallet: ShieldedWalletClass,
  readIfExists: (path: string) => Promise<string | undefined>,
) => {
  try {
    const serialized = await readIfExists(path);
    if (serialized) {
      const wallet = Wallet.restore(serialized);
      logger.info(`Restored shielded wallet from ${path}`);
      return wallet;
    }
    logger.warn("Unable to restore shielded wallet.");
  } catch (err: unknown) {
    logger.error(
      `Failed to restore shielded wallet: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return undefined;
};

const restoreUnshieldedWallet = async (
  path: string,
  walletConfig: DefaultConfiguration,
  readIfExists: (path: string) => Promise<string | undefined>,
) => {
  try {
    const serialized = await readIfExists(path);
    if (serialized) {
      const wallet = UnshieldedWallet({
        ...walletConfig,
        txHistoryStorage: new NoOpTransactionHistoryStorage(),
      }).restore(serialized);
      logger.info(`Restored unshielded wallet from ${path}`);
      return wallet;
    }
    logger.warn("Unable to restore unshielded wallet.");
  } catch (err: unknown) {
    logger.error(
      `Failed to restore unshielded wallet: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return undefined;
};

const restoreDustWallet = async (
  path: string,
  walletConfig: DefaultConfiguration,
  readIfExists: (path: string) => Promise<string | undefined>,
) => {
  try {
    const serialized = await readIfExists(path);
    if (serialized) {
      const DustInstance = DustWallet(walletConfig);
      const wallet = DustInstance.restore(serialized);
      logger.info(`Restored dust wallet from ${path}`);
      return wallet;
    }
    logger.warn("Unable to restore dust wallet.");
  } catch (err: unknown) {
    logger.error(
      `Failed to restore dust wallet: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return undefined;
};

export const provideWallet = async (
  filename: string,
  seed: string,
  walletConfig: DefaultConfiguration,
): Promise<WalletFacade> => {
  const Wallet = ShieldedWallet(walletConfig);
  const directoryPath = process.env["SYNC_CACHE"];
  if (!directoryPath) {
    logger.warn("SYNC_CACHE env var not set");
    exit(1);
  }

  const readIfExists = async (p: string): Promise<string | undefined> => {
    try {
      if (!existsSync(p)) return undefined;
      return await fsAsync.readFile(p, "utf-8");
    } catch (err: unknown) {
      logger.error(`Failed to read ${p}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };

  const [restoredShielded, restoredUnshielded, restoredDust] = await Promise.all([
    restoreShieldedWallet(`${directoryPath}/shielded-${filename}`, Wallet, readIfExists),
    restoreUnshieldedWallet(`${directoryPath}/unshielded-${filename}`, walletConfig, readIfExists),
    restoreDustWallet(`${directoryPath}/dust-${filename}`, walletConfig, readIfExists),
  ]);

  if (!restoredShielded || !restoredUnshielded || !restoredDust) {
    logger.info("Failed to restore one of the wallets. Building wallet facade from scratch");
    return buildWalletFacade(seed, walletConfig);
  } else {
    const restoredWallet = await WalletFacade.init({
      configuration: walletConfig,
      shielded: () => restoredShielded,
      unshielded: () => restoredUnshielded,
      dust: () => restoredDust,
    });
    // check if wallet is syncing correctly
    await waitForSync(restoredWallet);
    const restoredWalletState = await firstValueFrom(restoredWallet.state());
    const applyGap =
      restoredWalletState.unshielded.progress?.highestTransactionId -
      restoredWalletState.unshielded.progress?.appliedId;
    logger.info(`Apply gap: ${applyGap}`);
    if ((applyGap ?? 0) < 0) {
      logger.warn("Unable to sync restored wallet. Building wallet facade from scratch");
      return buildWalletFacade(seed, walletConfig);
    } else {
      logger.info("Successfully restored wallet facade.");
      return restoredWallet;
    }
  }
};

export const saveState = async (wallet: WalletFacade, filename: string) => {
  const directoryPath = process.env["SYNC_CACHE"];
  if (!directoryPath) {
    logger.warn("SYNC_CACHE env var not set");
    exit(1);
  }

  logger.info(`Saving state in ${directoryPath}/${filename}`);

  try {
    await fsAsync.mkdir(directoryPath, { recursive: true });

    // Serialize all three states
    const [shieldedSerializedState, unshieldedSerializedState, dustSerializedState] =
      await Promise.all([
        wallet.shielded.serializeState(),
        wallet.unshielded.serializeState(),
        wallet.dust.serializeState(),
      ]);

    logger.info("Serialized all wallet states.");
    const files = [
      { suffix: "shielded-", data: shieldedSerializedState },
      { suffix: "unshielded-", data: unshieldedSerializedState },
      { suffix: "dust-", data: dustSerializedState },
    ];

    const results = await Promise.allSettled(
      files.map((f) =>
        fsAsync.writeFile(`${directoryPath}/${f.suffix}${filename}`, f.data, "utf-8"),
      ),
    );

    for (const [i, res] of results.entries()) {
      const pathWritten = `${directoryPath}/${files[i].suffix}${filename}`;
      if (res.status === "fulfilled") {
        logger.info(`State written to file ${pathWritten}`);
      } else {
        logger.error(
          `Failed to write ${pathWritten}: ${res.reason instanceof Error ? res.reason.message : String(res.reason)}`,
        );
      }
    }
  } catch (e) {
    if (typeof e === "string") {
      logger.warn(e);
    } else if (e instanceof Error) {
      logger.warn(e.message);
    } else {
      logger.warn("Unknown error while saving state");
    }
  }
};

export const waitForSync = async (wallet: WalletFacade) =>
  await firstValueFrom(
    wallet.state().pipe(
      throttleTime(5000),
      filter((state) => state.isSynced === true),
    ),
  );

export const waitForUnshieldedSync = async (wallet: WalletFacade) =>
  await firstValueFrom(
    wallet.state().pipe(
      throttleTime(5000),
      filter((state) => state.unshielded.progress.isStrictlyComplete()),
    ),
  );

export const waitForPending = (wallet: WalletFacade) =>
  firstValueFrom(
    wallet.state().pipe(
      tap((state) => {
        const shieldedPending = state.shielded.pendingCoins.length;
        logger.info(
          `Shielded wallet pending coins: ${shieldedPending}, waiting for pending coins...`,
        );
        const unshieldedPending = state.unshielded.pendingCoins.length;
        logger.info(
          `Unshielded wallet pending coins: ${unshieldedPending}, waiting for pending coins...`,
        );
      }),
      filter(
        (state) =>
          // Let's allow progress only if pendingCoins are present
          state.shielded.pendingCoins.length > 0 || state.unshielded.pendingCoins.length > 0,
      ),
    ),
  );
export const waitForSyncProgress = async (wallet: WalletFacade) =>
  await firstValueFrom(
    wallet.state().pipe(
      throttleTime(5000),
      tap((state) => {
        const applyGap =
          state.unshielded.progress?.highestTransactionId - state.unshielded.progress?.appliedId;
        logger.info(`Wallet facade behind by ${applyGap}`);
      }),
      filter(
        (state) =>
          // Let's allow progress only if syncProgress is defined
          state.unshielded.progress !== undefined &&
          state.unshielded.progress?.highestTransactionId - state.unshielded.progress?.appliedId !==
            0n,
      ),
    ),
  );

export const waitForFinalizedBalance = (wallet: WalletFacade) =>
  firstValueFrom(
    wallet.state().pipe(
      tap((state) => {
        const shieldedPending = state.shielded.pendingCoins.length;
        logger.info(
          `Shielded wallet pending coins: ${shieldedPending}, waiting for pending coins to clear...`,
        );
        const unshieldedPending = state.unshielded.pendingCoins.length;
        logger.info(
          `Unshielded wallet pending coins: ${unshieldedPending}, waiting for pending coins to clear...`,
        );
        const dustPending = state.dust.pendingCoins.length;
        logger.info(
          `Dust wallet pending coins: ${dustPending}, waiting for pending coins to clear...`,
        );
      }),
      filter(
        (state) =>
          // Allow progress only if there are no pending coins
          state.shielded.pendingCoins.length == 0 &&
          state.unshielded.pendingCoins.length == 0 &&
          state.dust.pendingCoins.length == 0,
      ),
    ),
  );
export const isAnotherChain = async (wallet: ShieldedWallet, offset: number) => {
  const state = await wallet.waitForSyncedState();
  // allow for situations when there's no new index in the network between runs
  const applyGap = state.progress.highestRelevantIndex - state.progress.appliedIndex;
  return applyGap <= offset - 1;
};

export const streamToString = async (stream: fs.ReadStream): Promise<string> => {
  const chunks: string[] = [];
  return await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk as string));
    stream.on("error", (err) => reject(err));
    stream.on("end", () => resolve(chunks.join("")));
  });
};

export function getShieldedAddress(
  networkId: NetworkId.NetworkId,
  walletAddress: ShieldedAddress,
): string {
  return ShieldedAddress.codec.encode(networkId, walletAddress).asString();
}

export function getUnshieldedAddress(
  networkId: NetworkId.NetworkId,
  walletAddress: UnshieldedAddress,
): string {
  return UnshieldedAddress.codec.encode(networkId, walletAddress).asString();
}

export const getShieldedSeed = (seed: string): Uint8Array => {
  const seedBuffer = Buffer.from(seed, "hex");
  const hdWalletResult = HDWallet.fromSeed(seedBuffer);

  const { hdWallet } = hdWalletResult as {
    type: "seedOk";
    hdWallet: HDWallet;
  };

  const derivationResult = hdWallet.selectAccount(0).selectRole(Roles.Zswap).deriveKeyAt(0);

  if (derivationResult.type === "keyOutOfBounds") {
    throw new Error("Key derivation out of bounds");
  }

  return Buffer.from(derivationResult.key);
};

export const getUnshieldedSeed = (seed: string): Uint8Array => {
  const seedBuffer = Buffer.from(seed, "hex");
  const hdWalletResult = HDWallet.fromSeed(seedBuffer);

  const { hdWallet } = hdWalletResult as {
    type: "seedOk";
    hdWallet: HDWallet;
  };

  const derivationResult = hdWallet.selectAccount(0).selectRole(Roles.NightExternal).deriveKeyAt(0);

  if (derivationResult.type === "keyOutOfBounds") {
    throw new Error("Key derivation out of bounds");
  }

  return derivationResult.key;
};

export const getDustSeed = (seed: string): Uint8Array => {
  const seedBuffer = Buffer.from(seed, "hex");
  const hdWalletResult = HDWallet.fromSeed(seedBuffer);

  const { hdWallet } = hdWalletResult as {
    type: "seedOk";
    hdWallet: HDWallet;
  };

  const derivationResult = hdWallet.selectAccount(0).selectRole(Roles.Dust).deriveKeyAt(0);

  if (derivationResult.type === "keyOutOfBounds") {
    throw new Error("Key derivation out of bounds");
  }

  return derivationResult.key;
};

export const getFaucetEnvPage = (networkId: NetworkId.NetworkId, page: Page) => {
  switch (networkId) {
    case NetworkId.NetworkId.DevNet:
      return new DevnetFaucetMainPage(page);
    case NetworkId.NetworkId.QaNet:
      return new DevnetFaucetMainPage(page);
    case NetworkId.NetworkId.Preview:
      return new DevnetFaucetMainPage(page);
    case NetworkId.NetworkId.PreProd:
      return new DevnetFaucetMainPage(page);
    case "stagenet":
      return new DevnetFaucetMainPage(page);
    default:
      throw new Error("Unsupported network ID");
  }
};

export const getConstants = (networkId: NetworkId.NetworkId) => {
  switch (networkId) {
    case NetworkId.NetworkId.DevNet:
      return qanetConstants;
    case NetworkId.NetworkId.QaNet:
      return qanetConstants;
    case NetworkId.NetworkId.Preview:
      return qanetConstants;
    case NetworkId.NetworkId.PreProd:
      return qanetConstants;
    case "stagenet":
      return qanetConstants;
    default:
      throw new Error("Unsupported network ID");
  }
};

export type MidnightNetwork =
  | "undeployed"
  | "preview"
  | "preprod"
  | "devnet"
  | "qanet"
  | "stagenet";

export const waitForBalanceIncrease = async (
  wallet: WalletFacade,
  tokenRaw: string,
  initialBalance: bigint,
  dropAmount: bigint,
  maxAttempts = 10,
  streamTimeout = 60_000,
): Promise<bigint> => {
  const expectedBalance = initialBalance + dropAmount;
  logger.info(`Waiting for balance update — expected: ${expectedBalance}`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const state = await firstValueFrom(
        wallet.state().pipe(
          tap((s) => {
            const currentBalance = s.unshielded.balances[tokenRaw] ?? 0n;
            logger.info(
              `[Attempt ${attempt}] isSynced=${s.isSynced}, balance=${currentBalance}, expected=${expectedBalance}`,
            );
          }),
          timeout({ each: streamTimeout }),
          filter((s) => {
            const currentBalance = s.unshielded.balances[tokenRaw] ?? 0n;
            return currentBalance >= expectedBalance;
          }),
        ),
      );

      const finalBalance = state.unshielded.balances[tokenRaw];
      logger.info(`Final balance: ${finalBalance}`);
      return finalBalance;
    } catch {
      const currentState = await firstValueFrom(wallet.state());
      const currentBalance = currentState.unshielded.balances[tokenRaw] ?? 0n;
      logger.warn(
        `[Attempt ${attempt}/${maxAttempts}] Balance check failed — current: ${currentBalance}, expected: ${expectedBalance}. Re-syncing wallet...`,
      );
      if (attempt >= maxAttempts) {
        throw new Error(
          `Wallet balance did not reach expected value after ${maxAttempts} attempts. Current: ${currentBalance}, expected: ${expectedBalance}`,
        );
      }
      await waitForSync(wallet);
    }
  }

  throw new Error("Unreachable");
};
