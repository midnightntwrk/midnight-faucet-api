/* eslint-disable @typescript-eslint/no-base-to-string */
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { NetworkId, NoOpTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import { URL } from "node:url";
import pino from "pino";
import * as WalletSeedUtils from "./WalletSeedUtils.js";
import { type DefaultConfiguration, WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { DustSecretKey, LedgerParameters, ZswapSecretKeys } from "@midnight-ntwrk/ledger-v8";
import { pipe, Resource, Task } from "@midnight-ntwrk/faucet-utils";

export const DustOptions = {
  additionalFeeOverhead: 300_000_000_000_000n,
  feeBlocksMargin: 5,
};

export type FaucetWallet = WalletFacade;

export type WalletFactory<WalletConfig> = (walletConfig: WalletConfig) => {
  fromSeed: (seed: Buffer) => Resource<FaucetWallet>;
  fromSerializedState: (
    seed: Buffer,
    serializedState: {
      shielded: string | undefined;
      unshielded: string | undefined;
      dust: string | undefined;
    },
  ) => Resource<FaucetWallet>;
};

export type WalletURLs = {
  nodeURL: URL;
  indexerURL: URL;
  indexerSubscriptionURL: URL;
  provingServerURL: URL;
};

export const doCheck = (name: string, healthcheckURL: URL) => (logger: pino.Logger) => {
  logger.debug({ healthcheckURL }, `Pinging ${name}`);
  return fetch(healthcheckURL).then((response) => {
    if (!response.ok) {
      throw new Error(
        `Healthcheck from ${name} (${healthcheckURL.toString()}) failed with status ${
          response.status
        }`,
      );
    } else {
      return response;
    }
  });
};

export const checkNode = (nodeURL: URL) => async (logger: pino.Logger) => {
  logger.debug({ url: nodeURL }, "Pinging node");
  const httpUrl = new URL(nodeURL);
  const healthUrl = new URL("/health", httpUrl);

  healthUrl.protocol = httpUrl.protocol.startsWith("wss") ? "https" : "http";

  const response = await fetch(healthUrl);

  if (!response.ok) {
    throw new Error(`Node healthcheck failed with status ${response.status}`);
  }

  const body = (await response.json()) as { isSyncing?: boolean; shouldHavePeers?: boolean };

  if (!httpUrl.protocol.startsWith("wss")) {
    return response;
  }

  if (body.shouldHavePeers !== true && body.isSyncing === false) {
    throw new Error("Node is not syncing and should have peers");
  }

  return response;
};

export const checkIndexer = (indexerURL: URL) => {
  const httpUrl = new URL(indexerURL);
  const healthUrl = new URL("/health", httpUrl);
  if (!healthUrl.protocol.startsWith("wss")) {
    // When running locally (non-wss), return a no-op checker that assumes the indexer is ready.
    // This avoids callers having to guard for undefined and allows local dev to proceed.
    // eslint-disable-next-line @typescript-eslint/require-await
    return async (logger: pino.Logger) => {
      logger.debug(
        { url: indexerURL },
        "Skipping indexer healthcheck (non-wss) — assuming ready for local dev",
      );
      return new Response(null, { status: 200 });
    };
  }

  return doCheck("indexer", new URL("/ready", indexerURL));
};

export const checkProofServer = (proofServerURL: URL) => async (logger: pino.Logger) => {
  logger.debug({ url: proofServerURL }, "Pinging proof server");
  const response = await fetch(new URL("/health", proofServerURL));
  if (!response.ok) {
    throw new Error(`Proof server healthcheck failed with status ${response.status}`);
  }
  const body = (await response.json()) as { status?: string };
  if (body.status !== "ok") {
    throw new Error(`Proof server status is not ok: ${body.status}`);
  }
  return response;
};

export type CompositeSerializedState = {
  shielded: string | undefined;
  unshielded: string | undefined;
  dust: string | undefined;
};

export type StandardWalletConfig = {
  urls: WalletURLs;
  logLevel?: string;
  networkId: NetworkId.NetworkId;
};

const buildWalletFacade = async (
  { urls, networkId }: StandardWalletConfig,
  shieldedSeed: Uint8Array,
  unshieldedSeed: Uint8Array,
  dustSeed: Uint8Array,
  serializedState?: CompositeSerializedState,
  logger?: pino.Logger,
): Promise<WalletFacade> => {
  const config: DefaultConfiguration = {
    indexerClientConnection: {
      indexerHttpUrl: urls.indexerURL.toString(),
      indexerWsUrl: urls.indexerSubscriptionURL.toString(),
    },
    batchUpdates: {
      size: 600,
      timeout: 1000,
    },
    provingServerUrl: urls.provingServerURL,
    relayURL: urls.nodeURL,
    networkId,
    costParameters: {
      additionalFeeOverhead: DustOptions.additionalFeeOverhead,
      feeBlocksMargin: DustOptions.feeBlocksMargin,
    },
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
  };

  // Shielded wallet
  const shieldedWallet = ShieldedWallet(config);

  const shielded = serializedState?.shielded
    ? shieldedWallet.restore(serializedState.shielded)
    : shieldedWallet.startWithSeed(shieldedSeed);

  if (serializedState?.shielded) {
    logger?.info("Started shielded wallet from serialized state");
  } else {
    logger?.info("Started shielded wallet from seed");
  }

  // Unshielded wallet
  const unshieldedKeystore = createKeystore(unshieldedSeed, networkId);

  const unshieldedWallet = UnshieldedWallet({
    ...config,
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
  });

  const unshielded = serializedState?.unshielded
    ? unshieldedWallet.restore(serializedState.unshielded)
    : unshieldedWallet.startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));

  if (serializedState?.unshielded) {
    logger?.info("Started unshielded wallet from serialized state");
  } else {
    logger?.info("Started unshielded wallet from seed");
  }

  const Dust = DustWallet(config);

  const dustParameters = LedgerParameters.initialParameters().dust;
  const dust = serializedState?.dust
    ? Dust.restore(serializedState.dust)
    : Dust.startWithSeed(dustSeed, dustParameters);

  if (serializedState?.dust) {
    logger?.info("Started dust wallet from serialized state");
  } else {
    logger?.info("Started dust wallet from seed");
  }

  // Return a facade over the previously created wallets.
  return WalletFacade.init({
    configuration: config,
    shielded: () => shielded,
    unshielded: (): typeof unshielded => unshielded,
    dust: (): typeof dust => dust,
  });
};

export const isCorruptedStateError = (error: unknown): boolean => {
  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    if (err._tag === "Wallet.Other" && err.cause instanceof Error) {
      return err.cause.message.includes("inserted non-linearly");
    }
  }
  return false;
};

export const WalletFactory = (
  { urls, networkId }: StandardWalletConfig,
  logger: pino.Logger,
  onSyncError?: (error: unknown) => void,
) => ({
  fromSeed: (seed: Buffer): Resource<FaucetWallet> => {
    const shieldedSeed = WalletSeedUtils.getShieldedSeed(seed);
    const unshieldedSeed = WalletSeedUtils.getUnshieldedSeed(seed);
    const dustSeed = WalletSeedUtils.getDustSeed(seed);

    return Resource.make(
      pipe(
        Task.lift(() =>
          buildWalletFacade(
            { urls, networkId },
            shieldedSeed,
            unshieldedSeed,
            dustSeed,
            undefined,
            logger,
          ),
        ),
        Task.flatMapPromise(async (wallet: FaucetWallet) => {
          try {
            await wallet.start(
              ZswapSecretKeys.fromSeed(shieldedSeed),
              DustSecretKey.fromSeed(dustSeed),
            );
            return wallet;
          } catch (error: unknown) {
            let errorInfo: unknown = error;

            if (error && typeof error === "object") {
              const err = error as Record<string, unknown>;
              // Handle Effect library errors with _tag
              if (
                err._tag === "Wallet.Sync" ||
                err._tag === "Wallet.Error" ||
                err._tag === "Wallet.Other"
              ) {
                errorInfo = {
                  tag: err._tag,
                  message: err.message || String(err),
                  cause: err.cause,
                };
              } else if (error instanceof Error) {
                errorInfo = {
                  message: error.message,
                  name: error.name,
                  stack: error.stack,
                };
              } else if ("code" in err || "reason" in err) {
                // Handle WebSocket/EventSource close/error events
                errorInfo = {
                  type: err.type,
                  code: err.code,
                  reason: err.reason,
                  wasClean: err.wasClean,
                };
              }
            }

            logger.error({ errorInfo }, "Wallet failed to start");
            if (isCorruptedStateError(error)) onSyncError?.(error);
            throw error;
          }
        }),
      ),
      (wallet: FaucetWallet) => Task.lift(() => wallet.stop()),
    );
  },
  fromSerializedState: (
    seed: Buffer,
    serializedState: CompositeSerializedState,
  ): Resource<FaucetWallet> => {
    const shieldedSeed = WalletSeedUtils.getShieldedSeed(seed);
    const unshieldedSeed = WalletSeedUtils.getUnshieldedSeed(seed);
    const dustSeed = WalletSeedUtils.getDustSeed(seed);
    return Resource.make(
      pipe(
        Task.lift(() =>
          buildWalletFacade(
            { urls, networkId },
            shieldedSeed,
            unshieldedSeed,
            dustSeed,
            serializedState,
            logger,
          ),
        ),
        Task.flatMapPromise(async (wallet: FaucetWallet) => {
          logger.debug("Starting faucet from Serialized state");
          try {
            await wallet.start(
              ZswapSecretKeys.fromSeed(shieldedSeed),
              DustSecretKey.fromSeed(dustSeed),
            );
            return wallet;
          } catch (error: unknown) {
            let errorInfo: unknown = error;

            if (error && typeof error === "object") {
              const err = error as Record<string, unknown>;
              if (
                err._tag === "Wallet.Sync" ||
                err._tag === "Wallet.Error" ||
                err._tag === "Wallet.Other"
              ) {
                errorInfo = {
                  tag: err._tag,
                  message: err.message || String(err),
                  cause: err.cause,
                };
              } else if (error instanceof Error) {
                errorInfo = {
                  message: error.message,
                  name: error.name,
                  stack: error.stack,
                };
              } else if ("code" in err || "reason" in err) {
                errorInfo = {
                  type: err.type,
                  code: err.code,
                  reason: err.reason,
                  wasClean: err.wasClean,
                };
              }
            }

            logger.error({ errorInfo }, "Wallet failed to start");
            if (isCorruptedStateError(error)) onSyncError?.(error);
            throw error;
          }
        }),
      ),
      (wallet: FaucetWallet) => Task.lift(() => wallet.stop()),
    );
  },
});
