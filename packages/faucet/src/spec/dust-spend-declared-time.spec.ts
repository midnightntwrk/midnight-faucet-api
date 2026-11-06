import { describe, it, expect, vi } from "vitest";
import { Effect, SubscriptionRef } from "effect";
import {
  dustNullifier,
  DustLocalState,
  DustSecretKey,
  Intent,
  LedgerParameters,
  Transaction,
  type QualifiedDustOutput,
  type UnprovenTransaction,
} from "@midnightntwrk/ledger-v9";
import {
  NetworkId,
  NoOpTransactionHistoryStorage,
  ProtocolVersion,
} from "@midnightntwrk/wallet-sdk-abstractions";
import {
  CoinsAndBalances,
  CoreWallet,
  Keys,
  Transacting,
} from "@midnightntwrk/wallet-sdk-dust-wallet/v2";

import {
  DustOptions,
  DUST_BACKGROUND_SYNC_INTERVAL_MS,
  eventlessDustVariantBuilder,
  makeSyncTimeTransactingCapability,
  type EventlessDustConfiguration,
} from "../WalletFactory.js";

const blockTime = vi.hoisted(() => ({ tip: new Date("2026-06-01T12:00:00.000Z") }));

// The one thing a running variant needs from the indexer when balancing is the tip. Stubbing it is what lets these
// tests go through the real variant, capability and ledger without a chain.
//
// Mocked on the `/v2` subpath because that is where `WalletFactory` reaches the eventless sync service: the module the
// mock replaces has to be the module the code under test imports, or the stub is never reached and balancing asks a
// real indexer for the tip.
vi.mock("@midnightntwrk/wallet-sdk-dust-wallet/v2", async (importOriginal) => {
  const dustV2 = await importOriginal<typeof import("@midnightntwrk/wallet-sdk-dust-wallet/v2")>();
  const { Effect } = await import("effect");
  const { LedgerParameters } = await import("@midnightntwrk/ledger-v9");

  return {
    ...dustV2,
    SyncService: {
      ...dustV2.SyncService,
      makeEventLessSyncService: (
        ...args: Parameters<typeof dustV2.SyncService.makeEventLessSyncService>
      ): ReturnType<typeof dustV2.SyncService.makeEventLessSyncService> => ({
        ...dustV2.SyncService.makeEventLessSyncService(...args),
        blockData: () =>
          Effect.succeed({
            hash: "",
            height: 1,
            protocolVersion: 0,
            ledgerParameters: LedgerParameters.initialParameters(),
            timestamp: blockTime.tip,
            zswapEndIndex: 1,
            dustCommitmentEndIndex: 1,
            dustGenerationEndIndex: 1,
            dustCommitmentMerkleTreeRoot: "",
            dustGenerationMerkleTreeRoot: "",
          }),
      }),
    },
  };
});

const networkId = NetworkId.NetworkId.Undeployed;
const ledgerParameters = LedgerParameters.initialParameters();
const gracePeriodMs = Number(ledgerParameters.dust.dustGracePeriodSeconds) * 1_000;
// The ledger's default 1 hour `global_ttl`, less the margin the faucet leaves for proving and inclusion.
const rootHistoryMs = 55 * 60 * 1_000;
const twoHoursMs = 2 * 60 * 60 * 1_000;
const secretKey = DustSecretKey.fromSeed(new Uint8Array(32).fill(1));

const tip = blockTime.tip;
const ttl = new Date(tip.getTime() + 30 * 60 * 1_000);
const behindTip = (milliseconds: number) => new Date(tip.getTime() - milliseconds);

const configuration: EventlessDustConfiguration = {
  networkId,
  indexerClientConnection: {
    indexerHttpUrl: "http://localhost:8088/api/v1/graphql",
    indexerWsUrl: "ws://localhost:8088/api/v1/graphql/ws",
  },
  costParameters: {
    additionalFeeOverhead: DustOptions.additionalFeeOverhead,
    feeBlocksMargin: DustOptions.feeBlocksMargin,
  },
  txHistoryStorage: new NoOpTransactionHistoryStorage(),
  backgroundSyncInterval: DUST_BACKGROUND_SYNC_INTERVAL_MS,
};

/** A local dust state holding two coins with plenty of generated dust, as a wallet would after a sync pass. */
const dustStateWithCoins = (): DustLocalState =>
  [0n, 1n].reduce((state, index) => {
    const backingNight = index.toString(16).padStart(64, "0");
    const coin: QualifiedDustOutput = {
      initialValue: 0n,
      owner: secretKey.publicKey,
      nonce: index + 1n,
      seq: 0,
      ctime: behindTip(7 * 24 * 60 * 60 * 1_000),
      backingNight,
      mtIndex: index,
    };

    return state
      .insertGenerationInfo(
        index,
        { value: 10n ** 15n, owner: secretKey.publicKey, nonce: backingNight, dtime: undefined },
        backingNight,
      )
      .insertCommitment(index, coin, true)
      .addUtxo(dustNullifier(coin, secretKey), coin);
  }, new DustLocalState(ledgerParameters.dust));

const walletOf = (state: DustLocalState): CoreWallet =>
  CoreWallet.init(state, secretKey, networkId);

const walletSyncedTo = (syncTime: Date): CoreWallet => {
  const state = dustStateWithCoins();
  // A setter on a ledger object, which is how the eventless sync records it too.
  state.syncTime = syncTime;
  return walletOf(state);
};

const transactionToBalance = (): UnprovenTransaction =>
  Transaction.fromParts(networkId, undefined, undefined, Intent.new(ttl));

const context = (): Transacting.DefaultTransactingContext => ({
  coinSelection: CoinsAndBalances.chooseCoin,
  coinsAndBalancesCapability: CoinsAndBalances.makeDefaultCoinsAndBalancesCapability(
    configuration,
    () => ({ keysCapability: Keys.makeDefaultKeysCapability() }),
  ),
  keysCapability: Keys.makeDefaultKeysCapability(),
});

const balance = (
  wallet: CoreWallet,
  capability = makeSyncTimeTransactingCapability(configuration, context),
) => {
  const result = capability.balanceTransactions(
    secretKey,
    wallet,
    [transactionToBalance()],
    ttl,
    tip,
    ledgerParameters,
  );
  if (result._tag === "Left") {
    throw result.left;
  }
  return result.right;
};

const declaredTimeOf = (transaction: UnprovenTransaction): Date | undefined =>
  [...(transaction.intents?.values() ?? [])].at(0)?.dustActions?.ctime;

describe("makeSyncTimeTransactingCapability", () => {
  it("declares the time the wallet is synced to, not the tip's", () => {
    const syncTime = behindTip(30_000);

    const [balanced] = balance(walletSyncedTo(syncTime));

    expect(declaredTimeOf(balanced)).toEqual(syncTime);
  });

  it("prices coins at the declared time, which is what the ledger values them at", () => {
    const syncTime = behindTip(30_000);
    const coins = context();
    const pricedAt = vi.spyOn(
      coins.coinsAndBalancesCapability,
      "getAvailableCoinsWithGeneratedDust",
    );

    balance(
      walletSyncedTo(syncTime),
      makeSyncTimeTransactingCapability(configuration, () => coins),
    );

    expect(pricedAt).toHaveBeenCalledWith(expect.anything(), syncTime);
  });

  it("declares the same time for back-to-back spends with no sync pass between them", () => {
    const syncTime = behindTip(30_000);

    const [first, afterFirst] = balance(walletSyncedTo(syncTime));
    const [second, afterSecond] = balance(afterFirst);

    expect(declaredTimeOf(first)).toEqual(syncTime);
    expect(declaredTimeOf(second)).toEqual(syncTime);
    expect(afterSecond.pendingDust).toHaveLength(2);
  });

  it("declares a syncTime exactly as old as the ledger is assumed to keep its roots", () => {
    const syncTime = behindTip(rootHistoryMs);

    const [balanced] = balance(walletSyncedTo(syncTime));

    expect(declaredTimeOf(balanced)).toEqual(syncTime);
  });

  it("declares a syncTime ahead of the fetched tip, as a pass can finish after the tip is read", () => {
    const syncTime = new Date(tip.getTime() + 6_000);

    const [balanced] = balance(walletSyncedTo(syncTime));

    expect(declaredTimeOf(balanced)).toEqual(syncTime);
  });

  describe("falling back to the time it was given", () => {
    it("before the first pass, when syncTime is the epoch", () => {
      const wallet = walletOf(dustStateWithCoins());
      expect(wallet.state.syncTime).toEqual(new Date(0));

      const [balanced] = balance(wallet);

      expect(declaredTimeOf(balanced)).toEqual(tip);
    });

    it("when syncTime is older than the ledger is assumed to keep its roots", () => {
      const [balanced] = balance(walletSyncedTo(behindTip(rootHistoryMs + 1_000)));

      expect(declaredTimeOf(balanced)).toEqual(tip);
    });

    it("when syncTime is inside the grace period but its roots are gone", () => {
      expect(twoHoursMs).toBeLessThan(gracePeriodMs);

      const [balanced] = balance(walletSyncedTo(behindTip(twoHoursMs)));

      expect(declaredTimeOf(balanced)).toEqual(tip);
    });

    it("when syncTime is older than the grace period", () => {
      const [balanced] = balance(walletSyncedTo(behindTip(gracePeriodMs + 1_000)));

      expect(declaredTimeOf(balanced)).toEqual(tip);
    });

    it("when a restored snapshot carries a syncTime two hours old", () => {
      const snapshot = walletSyncedTo(behindTip(twoHoursMs)).state.serialize();

      const [balanced] = balance(walletOf(DustLocalState.deserialize(snapshot)));

      expect(declaredTimeOf(balanced)).toEqual(tip);
    });
  });

  it("still declares the syncTime of a restored snapshot whose roots the ledger keeps", () => {
    const syncTime = behindTip(30 * 60 * 1_000);
    const snapshot = walletSyncedTo(syncTime).state.serialize();

    const [balanced] = balance(walletOf(DustLocalState.deserialize(snapshot)));

    expect(declaredTimeOf(balanced)).toEqual(syncTime);
  });

  // Spreading the class instance would leave these undefined, and only a call at runtime would say so.
  it("still answers everything else the SDK's capability does", () => {
    const sdkCapability = Transacting.makeDefaultTransactingCapability(configuration, context);
    const capability = makeSyncTimeTransactingCapability(configuration, context);
    const transaction = transactionToBalance();
    const estimate = capability.estimateFee(
      secretKey,
      walletSyncedTo(tip),
      [transaction],
      ttl,
      tip,
      ledgerParameters,
    );

    expect(capability.networkId).toEqual(sdkCapability.networkId);
    expect(capability.costParams).toEqual(sdkCapability.costParams);
    expect(capability.calculateFee(transaction, ledgerParameters)).toEqual(
      sdkCapability.calculateFee(transaction, ledgerParameters),
    );
    expect(capability.splitNightUtxosForDustRegistration([], true)).toEqual(
      sdkCapability.splitNightUtxosForDustRegistration([], true),
    );
    // Not compared with the SDK's figure: the same estimate varies slightly from call to call.
    expect(estimate._tag).toEqual("Right");
  });

  it("releases the coin a reverted spend reserved", () => {
    const capability = makeSyncTimeTransactingCapability(configuration, context);
    const [balanced, afterSpend] = balance(walletSyncedTo(behindTip(30_000)), capability);

    const reverted = capability.revertTransaction(afterSpend, balanced);

    expect(reverted._tag === "Right" && reverted.right.pendingDust).toEqual([]);
  });
});

describe("eventlessDustVariantBuilder", () => {
  const balanceThroughVariant = (wallet: CoreWallet) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const stateRef = yield* SubscriptionRef.make(wallet);
          const variant = yield* eventlessDustVariantBuilder()
            .build(configuration)
            .start({
              stateRef,
              activationRange: ProtocolVersion.makeRange(
                ProtocolVersion.MinSupportedVersion,
                ProtocolVersion.MaxSupportedVersion,
              ),
            });
          return yield* variant.balanceTransactions(secretKey, [transactionToBalance()], ttl);
        }),
      ),
    );

  it("declares the synced time on the wallet's own balancing path", async () => {
    const syncTime = behindTip(30_000);

    const { transaction } = await balanceThroughVariant(walletSyncedTo(syncTime));

    expect(declaredTimeOf(transaction)).toEqual(syncTime);
  });

  it("falls back to the tip's time on the wallet's own balancing path", async () => {
    const { transaction } = await balanceThroughVariant(walletOf(dustStateWithCoins()));

    expect(declaredTimeOf(transaction)).toEqual(tip);
  });
});
