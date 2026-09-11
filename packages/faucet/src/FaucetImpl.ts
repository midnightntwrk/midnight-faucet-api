/* eslint-disable @typescript-eslint/prefer-promise-reject-errors */
import {
  Faucet,
  FaucetState,
  TokenResponse,
  WalletAddress,
} from "@midnightntwrk/faucet-internal-api";
import { pipe, Resource } from "@midnightntwrk/faucet-utils";
import { Duration } from "luxon";
import pino from "pino";
import { auditTime, firstValueFrom, map, Observable, shareReplay, Subject, tap } from "rxjs";
import { FaucetWallet, WalletFactory } from "./WalletFactory.js";
import { createKeystore, UnshieldedWalletState } from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { ShieldedWalletState } from "@midnightntwrk/wallet-sdk-shielded";
import { DustWalletState } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { DustSecretKey, ZswapSecretKeys, unshieldedToken } from "@midnightntwrk/ledger-v9";
import { WalletFacade, CombinedTokenTransfer } from "@midnightntwrk/wallet-sdk-facade";
import * as ledger from "@midnightntwrk/ledger-v9";

import { logTxFinalityOutcome, observeTxFinality } from "./observe-tx-finality.js";
import * as WalletSeedUtils from "./WalletSeedUtils.js";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import { MidnightBech32m, UnshieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";

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

/**
 * Maximum acceptable gap (in transaction ids / indices) between the wallet's
 * applied position and the chain tip for it to be considered "synced enough"
 * to operate on.
 *
 * NOTE: we intentionally do NOT use `isStrictlyComplete()` here. In the v9
 * wallet SDK that method requires an exact zero gap (`isCompleteWithin(0n)`),
 * which on a live network is essentially never true because the chain tip keeps
 * advancing. Requiring a strict gap of zero leaves `isSynced` permanently false,
 * which prevents the task worker from ever picking up drips (they stay stuck in
 * PENDING / "scheduled"). The SDK's own default tolerance is 50.
 */
const SYNC_GAP_TOLERANCE = 50n;

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
    isSynced: state.shielded.progress.isCompleteWithin(SYNC_GAP_TOLERANCE),
  };

  const unshieldedState = {
    address: state.unshielded.address,
    availableBalance: state.unshielded.balances[unshieldedToken] ?? 0n,
    availableCoins: state.unshielded.availableCoins.map((coin) => coin.utxo.value),
    totalCoins: state.unshielded.totalCoins.map((coin) => coin.utxo.value),
    pendingCoins: state.unshielded.pendingCoins.map((coin) => coin.utxo.value),
    syncProgress: state.unshielded.progress,
    isSynced: state.unshielded.progress.isCompleteWithin(SYNC_GAP_TOLERANCE),
  };

  const now = new Date();
  const dustBalance = state.dust.balance(now);

  const dustState = {
    availableBalance: dustBalance,
    availableCoins: state.dust.availableCoins.map((coin) => coin.token.initialValue),
    totalCoins: state.dust.totalCoins.map((coin) => coin.token.initialValue),
    pendingCoins: state.dust.pendingCoins.map((coin) => coin.generatedNow),
    syncProgress: state.dust.progress,
    isSynced: state.dust.progress.isCompleteWithin(SYNC_GAP_TOLERANCE),
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

export const mkRequestTokens = (
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

    const shieldedSeed = WalletSeedUtils.getShieldedSeed(config.walletSeed);
    const unshieldedSeed = WalletSeedUtils.getUnshieldedSeed(config.walletSeed);
    const dustSeed = WalletSeedUtils.getDustSeed(config.walletSeed);

    const unshieldedSenderKeystore = createKeystore(
      { kind: "schnorr", secret: unshieldedSeed },
      config.networkId,
    );

    const state = await firstValueFrom(wallet.state());
    const faucetState = calculateFaucetState(state);

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

    // Building the transfer reserves the selected coins into `pending`. Attempt
    // the sign/submit as a unit that reports whether it reached a successful
    // submit, so the caller can release the reservation on any earlier failure —
    // otherwise a failed attempt strands the coins in pending until restart/resync.
    type TransferResult =
      | { submitted: true; submittedTxHash: string; finalizedTxHash: string }
      | {
          submitted: false;
          recipe: Awaited<ReturnType<typeof wallet.transferTransaction>>;
          error: unknown;
        };

    const attemptTransfer = async (): Promise<TransferResult> => {
      const ttl = new Date(Date.now() + 30 * 60 * 1000);
      const recipe = await wallet.transferTransaction(
        tokenTransfer,
        {
          shieldedSecretKeys: ZswapSecretKeys.fromSeed(shieldedSeed),
          dustSecretKey: DustSecretKey.fromSeed(dustSeed),
        },
        {
          ttl,
        },
      );

      try {
        const signedTxRecipe = await wallet.signRecipe(recipe, (payload) =>
          unshieldedSenderKeystore.signDataAsync(payload),
        );

        const finalizedTx = await wallet.finalizeRecipe(signedTxRecipe);
        const finalizedTxHash = finalizedTx.transactionHash().toString();

        logger.info("We have a recipe to submit");
        const submittedTxHash = await wallet.submitTransaction(finalizedTx);

        logger.info(`We have a transaction hash. ${submittedTxHash}`);
        return { submitted: true, submittedTxHash, finalizedTxHash };
      } catch (error: unknown) {
        return { submitted: false, recipe, error };
      }
    };

    try {
      const result = await attemptTransfer();

      if (!result.submitted) {
        // Reserved by transferTransaction but never submitted — release the reservation.
        try {
          await wallet.revert(result.recipe);
        } catch (revertError: unknown) {
          requestLogger.error(
            { err: revertError },
            "Failed to release reserved coins after aborted request",
          );
        }
        throw result.error;
      }

      // Watch for finality in the background without blocking the response. The
      // drip is already submitted at this point, so nothing here can change its
      // outcome — the only job is to report what the network did with it.
      void observeTxFinality(
        (hash) => wallet.queryTxHistoryByHash(hash),
        result.finalizedTxHash,
        requestLogger,
      )
        .then((outcome) => logTxFinalityOutcome(requestLogger, outcome, result.finalizedTxHash))
        .catch((err: unknown) => {
          requestLogger.error({ err }, "Unexpected error during background validation");
        });

      return {
        transactionIdentifier: result.submittedTxHash,
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
