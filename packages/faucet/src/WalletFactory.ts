/* eslint-disable @typescript-eslint/no-base-to-string */
import {
  createKeystore,
  CustomUnshieldedWallet,
  PublicKey,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { V2Builder as UnshieldedV2Builder } from "@midnightntwrk/wallet-sdk-unshielded-wallet/v2";
import {
  NetworkId,
  NoOpTransactionHistoryStorage,
  ProtocolVersion,
} from "@midnightntwrk/wallet-sdk-abstractions";
import { URL } from "node:url";
import pino from "pino";
import * as WalletSeedUtils from "./WalletSeedUtils.js";
import { type ResolvedConfiguration, WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { CustomShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import { V2Builder as ShieldedV2Builder } from "@midnightntwrk/wallet-sdk-shielded/v2";
import {
  CustomDustWallet,
  makeEventLessSyncCapability,
  makeEventLessSyncService,
} from "@midnightntwrk/wallet-sdk-dust-wallet";
import {
  type DefaultV2Configuration,
  type V2Variant,
  V2Builder as DustV2Builder,
  SyncService as DustSyncService,
} from "@midnightntwrk/wallet-sdk-dust-wallet/v2";
import { VariantBuilder } from "@midnightntwrk/wallet-sdk-runtime/abstractions";
import { DustSecretKey, FinalizedTransaction, LedgerParameters } from "@midnightntwrk/ledger-v9";
import { pipe, Resource, Task } from "@midnightntwrk/faucet-utils";

export const DustOptions = {
  additionalFeeOverhead: 300_000_000_000_000n,
  feeBlocksMargin: 5,
};

/**
 * The faucet's chain is ledger-v9 from its first block, so its timeline has a single epoch and no v8 side.
 *
 * A boundary at the floor is how the SDK expresses that: `epochOf` collapses to one range when the handover is at
 * or below the minimum supported version, and the facade's `authoring()` then resolves to v9 for every version it
 * can ever observe.
 *
 * This is what makes the single-variant wallets below usable. Each registers its one variant at the minimum
 * supported version and stamps every transaction there, and the facade has to accept those alongside each other
 * when it merges balancing transactions. The price is that this wallet cannot follow a chain across the v8 → v9
 * fork — pointing the faucet at a pre-fork network means the forking wallets and `DefaultForkSchedule` again.
 */
export const LedgerV9OnlySchedule: ProtocolVersion.ForkSchedule = {
  v9: ProtocolVersion.MinSupportedVersion,
};

/**
 * How long the eventless dust sync waits between passes.
 *
 * Event replay rides a subscription that never completes, so it needs no such number. The projections path
 * synchronizes in finite passes instead and has to be told how often to run one. A pass with nothing to do costs a
 * single block query, so this trades idle indexer traffic against how far behind the tip dust balances may lag
 * when a drip is priced.
 */
export const DUST_BACKGROUND_SYNC_INTERVAL_MS = 5_000;

/**
 * What the eventless sync service folds into the wallet — the dust package's `DustProjectionsUpdate`.
 *
 * Recovered from the service's own signature because the package does not re-export `v2/SyncSchema`, so the type
 * has no name reachable from here. It is needed only to annotate {@link eventlessDustVariantBuilder}, whose
 * inferred type would otherwise reference it and be unwriteable in the emitted declarations.
 */
type EventlessDustUpdate =
  ReturnType<typeof makeEventLessSyncService> extends DustSyncService.SyncService<
    infer _State,
    infer _StartAux,
    infer Update
  >
    ? Update
    : never;

/** The configuration {@link eventlessDustVariantBuilder} builds against. */
export type EventlessDustConfiguration = DefaultV2Configuration &
  DustSyncService.DefaultSyncConfiguration;

/**
 * The dust variant the faucet runs: projections-based ("eventless") sync rather than a replay of the indexer's dust
 * event log.
 *
 * That path is a ledger-v9 capability — it reads four `DustLocalState` members no published ledger-v8 has — so it
 * can only run under a single-variant wallet, which is what {@link LedgerV9OnlySchedule} exists to make coherent.
 *
 * Separate from {@link buildWalletFacade} so it can be built in a test without standing up a facade: an incomplete
 * builder is only refused by `build()`, at runtime, and nothing in the types says which capability is missing.
 */
export const eventlessDustVariantBuilder = (): VariantBuilder.VariantBuilder<
  V2Variant<string, EventlessDustUpdate, FinalizedTransaction, DustSecretKey>,
  EventlessDustConfiguration
> =>
  new DustV2Builder()
    .withDefaults()
    .withSync(makeEventLessSyncService, makeEventLessSyncCapability)
    // `withSync` drops the seed-to-key derivation, because it is typed against the start-aux of the sync service
    // being replaced. The eventless service starts from a `DustSecretKey` like the default one, so the default
    // derivation is what belongs here — but it has to be restated, and only `build()` will say so.
    .withStartAuxDefaults();

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
  // `backgroundSyncInterval` belongs to the dust package's sync configuration rather than to the facade's, which
  // names only what the wallets it ships ask for — and the wallet it ships syncs from a subscription that has no
  // interval. The facade is generic over the configuration precisely so it can carry a field like this through to
  // the wallets built from it.
  const config: ResolvedConfiguration & { backgroundSyncInterval: number } = {
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
    backgroundSyncInterval: DUST_BACKGROUND_SYNC_INTERVAL_MS,
    // The per-wallet configurations require a fork schedule; only the facade presets one.
    forks: LedgerV9OnlySchedule,
  };

  // Shielded wallet
  const shieldedWallet = CustomShieldedWallet(config, new ShieldedV2Builder().withDefaults());

  const shielded = serializedState?.shielded
    ? shieldedWallet.restore(serializedState.shielded)
    : shieldedWallet.startWithSeed(shieldedSeed);

  if (serializedState?.shielded) {
    logger?.info("Started shielded wallet from serialized state");
  } else {
    logger?.info("Started shielded wallet from seed");
  }

  // Unshielded wallet
  const unshieldedKeystore = createKeystore({ kind: "schnorr", secret: unshieldedSeed }, networkId);

  const unshieldedWallet = CustomUnshieldedWallet(
    { ...config, txHistoryStorage: new NoOpTransactionHistoryStorage() },
    new UnshieldedV2Builder().withDefaults(),
  );

  const unshielded = serializedState?.unshielded
    ? unshieldedWallet.restore(serializedState.unshielded)
    : unshieldedWallet.startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));

  if (serializedState?.unshielded) {
    logger?.info("Started unshielded wallet from serialized state");
  } else {
    logger?.info("Started unshielded wallet from seed");
  }

  const Dust = CustomDustWallet(config, eventlessDustVariantBuilder());

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
            await wallet.start({
              shielded: shieldedSeed,
              unshielded: unshieldedSeed,
              dust: dustSeed,
            });
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
          ).catch((error: unknown) => {
            // A snapshot these wallets cannot read is an ordinary thing to meet, not a bug: the single-variant
            // compositions read ledger-v9 only, so anything written by a wallet running the ledger-v8 variant is
            // bytes they have no reader for. Syncing from the seed is slow but correct, and the alternative is a
            // start that throws before there is a wallet for the stuck-sync detector to recover.

            // The reason is spelled out rather than logged as `{ error }`: the SDK raises Effect tagged errors,
            // whose own properties are non-enumerable, so pino renders them as `{}` and the cause is lost.
            logger.warn(
              { reason: error instanceof Error ? error.message : String(error) },
              "Could not restore the wallet from its snapshot — falling back to a sync from seed",
            );
            return buildWalletFacade(
              { urls, networkId },
              shieldedSeed,
              unshieldedSeed,
              dustSeed,
              undefined,
              logger,
            );
          }),
        ),
        Task.flatMapPromise(async (wallet: FaucetWallet) => {
          logger.debug("Starting faucet from Serialized state");
          try {
            await wallet.start({
              shielded: shieldedSeed,
              unshielded: unshieldedSeed,
              dust: dustSeed,
            });
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
