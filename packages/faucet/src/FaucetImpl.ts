/* eslint-disable @typescript-eslint/prefer-promise-reject-errors */
import {
  Faucet,
  FaucetState,
  TokenResponse,
  WalletAddress,
} from "@midnight-ntwrk/faucet-internal-api";
import { pipe, Resource } from "@midnight-ntwrk/faucet-utils";
import { Duration } from "luxon";
import pino from "pino";
import {
  auditTime,
  firstValueFrom,
  map,
  Observable,
  shareReplay,
  Subject,
  tap,
  timeout,
  filter,
  concatMap,
} from "rxjs";
import { FaucetWallet, WalletFactory } from "./WalletFactory.js";
import {
  createKeystore,
  UnshieldedWalletState,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { ShieldedWalletState } from "@midnight-ntwrk/wallet-sdk-shielded";
import { DustWalletState } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { DustSecretKey, ZswapSecretKeys, unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import { WalletFacade, CombinedTokenTransfer } from "@midnight-ntwrk/wallet-sdk-facade";
import * as ledger from "@midnight-ntwrk/ledger-v8";

import * as WalletSeedUtils from "./WalletSeedUtils.js";
import { NetworkId } from "@midnight-ntwrk/wallet-sdk-abstractions";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";

export type FaucetConfig<WalletConfig> = {
  networkId: NetworkId.NetworkId;
  dropAmount: string;
  targetCoinNumber: number;
  targetCoinSizeFactor: bigint;
  walletSeed: Buffer;
  numberOfOutputs: number;
  walletConfig: WalletConfig;
};

export type WalletState = {
  unshielded: UnshieldedWalletState;
  shielded: ShieldedWalletState;
  dust: DustWalletState;
};

export class InsufficientFundsError extends Error {
  private static walletErrorRegexp = /Not sufficient funds to balance token: /;

  static doesWalletErrorMatch(error: Error): boolean {
    return InsufficientFundsError.walletErrorRegexp.test(error.message);
  }

  constructor(
    public readonly transferValue: bigint,
    options?: ErrorOptions,
  ) {
    super(`Insufficient funds to move ${transferValue}`, options);
  }
}

export const calculateFaucetState = (state: WalletState): FaucetState => {
  const unshieldedToken = ledger.unshieldedToken().raw;
  const shieldedToken = ledger.shieldedToken().raw;

  const shieldedState = {
    address: state.shielded.address,
    availableBalance: state.shielded.balances[shieldedToken] ?? 0n,
    availableCoins: state.shielded.availableCoins.map((c) => c.coin.value),
    totalCoins: state.shielded.totalCoins.map((c) => c.coin.value),
    pendingCoins: state.shielded.pendingCoins.map((c) => c.coin.value),
    syncProgress: state.shielded.progress,
    isSynced: state.shielded.progress.isStrictlyComplete(),
  };

  const unshieldedState = {
    address: state.unshielded.address,
    availableBalance: state.unshielded.balances[unshieldedToken] ?? 0n,
    availableCoins: state.unshielded.availableCoins.map((coin) => coin.utxo.value),
    totalCoins: state.unshielded.totalCoins.map((coin) => coin.utxo.value),
    pendingCoins: state.unshielded.pendingCoins.map((coin) => coin.utxo.value),
    syncProgress: state.unshielded.progress,
    isSynced: state.unshielded.progress.isStrictlyComplete(),
  };

  const now = new Date();
  const dustBalance = state.dust.balance(now);

  const dustState = {
    availableBalance: dustBalance,
    availableCoins: state.dust.availableCoins.map((coin) => coin.token.initialValue),
    totalCoins: state.dust.totalCoins.map((coin) => coin.token.initialValue),
    pendingCoins: state.dust.pendingCoins.map((coin) => coin.generatedNow),
    syncProgress: state.dust.progress,
    isSynced: state.dust.progress.isStrictlyComplete(),
  };

  return {
    shielded: shieldedState,
    unshielded: unshieldedState,
    dust: dustState,
  };
};

const hasEnoughCoins = (state: FaucetState, config: FaucetConfig<unknown>) =>
  state.unshielded.totalCoins.length >= config.targetCoinNumber;

/**
 * Checks, whether it is reasonable to create a new coin for itself.
 * Mostly to prevent churning with coins creation when the wallet balance starts to approach 0
 */
const isNewCoinReasonable = (state: FaucetState, config: FaucetConfig<unknown>) => {
  const minimalReasonableBalance =
    config.targetCoinSizeFactor * BigInt(config.dropAmount) * BigInt(config.targetCoinNumber);

  return state.unshielded.availableBalance > minimalReasonableBalance;
};

const coinArraysChanged = (prev: WalletState, curr: WalletState): boolean => {
  return (
    prev.shielded.availableCoins !== curr.shielded.availableCoins ||
    prev.shielded.totalCoins !== curr.shielded.totalCoins ||
    prev.shielded.pendingCoins !== curr.shielded.pendingCoins ||
    prev.unshielded.availableCoins !== curr.unshielded.availableCoins ||
    prev.unshielded.totalCoins !== curr.unshielded.totalCoins ||
    prev.unshielded.pendingCoins !== curr.unshielded.pendingCoins ||
    prev.dust.availableCoins !== curr.dust.availableCoins ||
    prev.dust.totalCoins !== curr.dust.totalCoins ||
    prev.dust.pendingCoins !== curr.dust.pendingCoins
  );
};

export const getFaucetState = (
  logger: pino.Logger,
  wallet: FaucetWallet,
): Observable<FaucetState> => {
  let previousWalletState: WalletState | undefined;
  let cachedFaucetState: FaucetState | undefined;

  return wallet.state().pipe(
    auditTime(250),
    map((state: WalletState) => {
      if (previousWalletState && !coinArraysChanged(previousWalletState, state)) {
        return cachedFaucetState!;
      }
      previousWalletState = state;
      cachedFaucetState = calculateFaucetState(state);
      return cachedFaucetState;
    }),
    tap((faucetState) =>
      logger.debug(
        {
          shielded: {
            availableBalance: faucetState.shielded.availableBalance,
            isSynced: faucetState.shielded.isSynced,
            coinCounts: {
              available: faucetState.shielded.availableCoins.length,
              total: faucetState.shielded.totalCoins.length,
              pending: faucetState.shielded.pendingCoins.length,
            },
          },
          unshielded: {
            availableBalance: faucetState.unshielded.availableBalance,
            isSynced: faucetState.unshielded.isSynced,
            syncGap:
              faucetState.unshielded.syncProgress.highestTransactionId -
              faucetState.unshielded.syncProgress.appliedId,
            coinCounts: {
              available: faucetState.unshielded.availableCoins.length,
              total: faucetState.unshielded.totalCoins.length,
              pending: faucetState.unshielded.pendingCoins.length,
            },
          },
          dust: {
            availableBalance: faucetState.dust.availableBalance,
            isSynced: faucetState.dust.isSynced,
            coinCounts: {
              available: faucetState.dust.availableCoins.length,
              total: faucetState.dust.totalCoins.length,
              pending: faucetState.dust.pendingCoins.length,
            },
          },
        },
        "Faucet wallet state",
      ),
    ),
    shareReplay({ bufferSize: 1, refCount: true }),
  );
};

export const getWalletAddress = (
  wallet: WalletFacade,
  networkId: NetworkId.NetworkId,
): Promise<WalletAddress> =>
  firstValueFrom(wallet.state()).then((state) => {
    return UnshieldedAddress.codec.encode(networkId, state.unshielded.address).asString();
  });

const mkRequestTokens = (
  logger: pino.Logger,
  config: FaucetConfig<unknown>,
  wallet: FaucetWallet,
) => {
  return async <T extends object>(
    address: WalletAddress,
    requestContext?: T,
    amount?: bigint,
  ): Promise<TokenResponse> => {
    const fullContext = { ...requestContext, address };
    const requestLogger = logger.child(fullContext);
    requestLogger.debug("Handling request for tokens");

    const shieldedSeed = WalletSeedUtils.getShieldedSeed(config.walletSeed as Uint8Array);
    const unshieldedSeed = WalletSeedUtils.getUnshieldedSeed(config.walletSeed as Uint8Array);
    const dustSeed = WalletSeedUtils.getDustSeed(config.walletSeed as Uint8Array);

    const unshieldedSenderKeystore = createKeystore(unshieldedSeed, config.networkId);

    const state = await firstValueFrom(wallet.state());
    const faucetState = calculateFaucetState(state);

    // Snapshot available coins BEFORE building transaction to detect if they get spent
    const availableUnshieldedCoins = new Set(
      state.unshielded.availableCoins.map((c) => `${c.utxo.intentHash}#${c.utxo.outputNo}`),
    );

    // Create a new coin for itself when wallet balance approaches 0.
    const selfOutputs =
      !hasEnoughCoins(faucetState, config) && isNewCoinReasonable(faucetState, config)
        ? [
            {
              amount: BigInt(config.dropAmount) * config.targetCoinSizeFactor,
              receiverAddress: state.unshielded.address,
              type: unshieldedToken().raw,
            },
          ]
        : [];

    const effectiveAmount = amount ?? BigInt(config.dropAmount);
    const requestOutputValue = effectiveAmount / BigInt(config.numberOfOutputs);
    const receiverUnshieldedAddress = MidnightBech32m.parse(address).decode(
      UnshieldedAddress,
      config.networkId,
    );
    const requestOutputs = Array.from({ length: config.numberOfOutputs }).map(() => ({
      amount: requestOutputValue,
      receiverAddress: receiverUnshieldedAddress,
      type: unshieldedToken().raw,
    }));

    const tokenTransfer: CombinedTokenTransfer[] = [
      {
        type: "unshielded",
        outputs: [...selfOutputs, ...requestOutputs],
      },
    ];

    try {
      const ttl = new Date(Date.now() + 30 * 60 * 1000);
      const transaction = await wallet.transferTransaction(
        tokenTransfer,
        {
          shieldedSecretKeys: ZswapSecretKeys.fromSeed(shieldedSeed),
          dustSecretKey: DustSecretKey.fromSeed(dustSeed),
        },
        {
          ttl,
        },
      );

      // Validate coins still exist before signing (detect concurrent spending)
      const preSigState = await firstValueFrom(wallet.state());
      const stillAvailable = preSigState.unshielded.availableCoins.some((c) =>
        availableUnshieldedCoins.has(`${c.utxo.intentHash}#${c.utxo.outputNo}`),
      );
      if (!stillAvailable) {
        throw new InsufficientFundsError(effectiveAmount, {
          cause: new Error("Selected coins no longer available"),
        });
      }

      const signedTxRecipe = await wallet.signRecipe(transaction, (payload) =>
        unshieldedSenderKeystore.signData(payload),
      );

      const finalizedTx = await wallet.finalizeRecipe(signedTxRecipe);
      const finalizedTxHash = finalizedTx.transactionHash().toString();

      logger.info("We have a recipe to submit");
      const submittedTxHash = await wallet.submitTransaction(finalizedTx);

      logger.info(`We have a transaction hash. ${submittedTxHash}`);

      // Validate transaction in background without blocking response
      firstValueFrom(
        wallet.state().pipe(
          concatMap(() => wallet.queryTxHistoryByHash(finalizedTxHash)),
          filter((entry) => entry !== undefined && entry.status === "SUCCESS"),
          timeout(30_000),
        ),
      )
        .then(
          () => {
            requestLogger.debug("Transaction confirmed in history");
          },
          (historyError: unknown) => {
            requestLogger.warn(
              { err: historyError },
              "Transaction history validation failed in background",
            );
          },
        )
        .catch((err) => {
          requestLogger.error({ err }, "Unexpected error during background validation");
        });

      return {
        transactionIdentifier: submittedTxHash,
        timeToNextRequest: Duration.fromMillis(0),
      };
    } catch (error: unknown) {
      requestLogger.error({ err: error }, "Error while preparing transaction");
      if (InsufficientFundsError.doesWalletErrorMatch(error as Error)) {
        throw new InsufficientFundsError(effectiveAmount, { cause: error });
      } else if (error instanceof InsufficientFundsError) {
        throw error;
      } else {
        return Promise.reject(error);
      }
    }
  };
};

export const FaucetImpl = <WalletConfig>(
  config: FaucetConfig<WalletConfig>,
  dependencies: {
    walletFactory: ReturnType<WalletFactory<WalletConfig>>;
    logger: pino.Logger;
    cachedState?: {
      shielded: string | undefined;
      unshielded: string | undefined;
      dust: string | undefined;
    };
    syncErrorSubject?: Subject<unknown>;
  },
): Resource<Faucet> => {
  const syncErrors$ = dependencies.syncErrorSubject ?? new Subject<unknown>();
  return pipe(
    dependencies.cachedState !== undefined
      ? dependencies.walletFactory.fromSerializedState(config.walletSeed, dependencies.cachedState)
      : dependencies.walletFactory.fromSeed(config.walletSeed),
    Resource.mapPromise(async (wallet) => {
      const requestTokens = mkRequestTokens(dependencies.logger, config, wallet);
      return {
        dropAmount: config.dropAmount,
        address: await getWalletAddress(wallet, config.networkId).then((address) => {
          dependencies.logger.info({ address }, "Faucet's wallet address");
          return address;
        }),
        state$: getFaucetState(dependencies.logger, wallet),

        syncErrors$: syncErrors$.asObservable(),
        serializeWalletState: () => ({
          shielded: wallet.shielded.serializeState(),
          unshielded: wallet.unshielded.serializeState(),
          dust: wallet.dust.serializeState(),
        }),
        requestTokens,
      };
    }),
  );
};
