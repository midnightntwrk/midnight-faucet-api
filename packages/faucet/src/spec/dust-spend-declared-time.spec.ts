import { describe, it, expect, vi } from "vitest";
import { Cause, Effect, Exit, Fiber, SubscriptionRef, TestClock, TestContext } from "effect";
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
import { ScaleBigInt } from "@midnightntwrk/wallet-sdk-address-format";
import { CoreWallet, PublicKey } from "@midnightntwrk/wallet-sdk-dust-wallet/v2";

import {
  DustOptions,
  DUST_BACKGROUND_SYNC_INTERVAL_MS,
  eventlessDustVariantBuilder,
  type EventlessDustConfiguration,
} from "../WalletFactory.js";

/**
 * The time a dust spend declares picks the Merkle roots the ledger checks its proof against, and the proof is built
 * from the wallet's own trees. Declaring the indexer tip's time while the wallet's trees are a pass behind it is what
 * failed drips with `InvalidDustSpendProof` (#163). The dust wallet now picks that time itself; these tests pin that
 * it still does, through the variant the faucet runs.
 */

type Roots = { commitment: string; generation: string };
type Block = { height: number; timestamp: Date; roots: Roots };

const chain = vi.hoisted(() => ({ tipHeight: 0, blocks: new Map<number, Block>() }));

// Balancing asks the indexer for the tip and for the block the wallet's last pass verified. Serving both from `chain`
// lets these tests go through the real variant, spend-time decision and ledger without a chain.
//
// Mocked on the `/v2` subpath because that is where `WalletFactory` reaches the eventless sync service.
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
        blockData: (height?: number) => {
          const block = chain.blocks.get(height ?? chain.tipHeight);
          return block === undefined
            ? Effect.die(new Error(`The test chain has no block at height ${height}`))
            : Effect.succeed({
                hash: "",
                height: block.height,
                protocolVersion: 0,
                ledgerParameters: LedgerParameters.initialParameters(),
                timestamp: block.timestamp,
                zswapEndIndex: 1,
                dustCommitmentEndIndex: 1,
                dustGenerationEndIndex: 1,
                dustCommitmentMerkleTreeRoot: block.roots.commitment,
                dustGenerationMerkleTreeRoot: block.roots.generation,
              });
        },
      }),
    },
  };
});

const networkId = NetworkId.NetworkId.Undeployed;
const ledgerParameters = LedgerParameters.initialParameters();
const secretKey = DustSecretKey.fromSeed(new Uint8Array(32).fill(1));

const tipTime = new Date("2026-06-01T12:00:00.000Z");
const ttl = new Date(tipTime.getTime() + 30 * 60 * 1_000);
const behindTip = (milliseconds: number) => new Date(tipTime.getTime() - milliseconds);
const TIP_HEIGHT = 105;
const VERIFIED_HEIGHT = 100;

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

/** A local dust state holding two coins with plenty of generated dust, synced to `syncTime`. */
const dustStateWithCoins = (syncTime: Date): DustLocalState => {
  const state = [0n, 1n].reduce((current, index) => {
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

    return current
      .insertGenerationInfo(
        index,
        { value: 10n ** 15n, owner: secretKey.publicKey, nonce: backingNight, dtime: undefined },
        backingNight,
      )
      .insertCommitment(index, coin, true)
      .addUtxo(dustNullifier(coin, secretKey), coin);
  }, new DustLocalState(ledgerParameters.dust));
  // A setter on a ledger object, which is how the eventless sync records it too.
  state.syncTime = syncTime;
  return state;
};

// The indexer reports a root as its SCALE compact encoding, in hex.
const indexerEncoded = (root: bigint | undefined): string =>
  root === undefined ? "" : ScaleBigInt.encode(root).toString("hex");

const rootsOf = (state: DustLocalState): Roots => ({
  commitment: indexerEncoded(state.commitmentTreeRoot()),
  generation: indexerEncoded(state.generatingTreeRoot()),
});

/** Roots no wallet in these tests holds: the chain's trees after blocks the wallet has not synced. */
const movedOnRoots: Roots = { commitment: "ab".repeat(33), generation: "cd".repeat(33) };

/** The wallet as an eventless pass leaves it: projections progress at the block it verified, synced to its time. */
const walletAfterPassAt = (syncTime: Date): CoreWallet =>
  CoreWallet.restore(
    dustStateWithCoins(syncTime),
    PublicKey.fromSecretKey(secretKey),
    [],
    {
      appliedIndex: 0n,
      highestRelevantWalletIndex: 0n,
      highestIndex: BigInt(VERIFIED_HEIGHT),
      highestRelevantIndex: 0n,
    },
    ProtocolVersion.MinSupportedVersion,
    networkId,
    "projections",
  );

const chainWith = (tip: Omit<Block, "height">, verified?: Omit<Block, "height">): void => {
  chain.tipHeight = TIP_HEIGHT;
  chain.blocks = new Map([
    [TIP_HEIGHT, { ...tip, height: TIP_HEIGHT }],
    ...(verified === undefined
      ? []
      : [[VERIFIED_HEIGHT, { ...verified, height: VERIFIED_HEIGHT }] as const]),
  ]);
};

const transactionToBalance = (): UnprovenTransaction =>
  Transaction.fromParts(networkId, undefined, undefined, Intent.new(ttl));

const declaredTimeOf = (transaction: UnprovenTransaction): Date | undefined =>
  [...(transaction.intents?.values() ?? [])].at(0)?.dustActions?.ctime;

/** Balances `spends` transactions one after another through the faucet's dust variant, with no sync pass between. */
const balanceThroughVariant = (wallet: CoreWallet, spends: number) =>
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
      const transactions = yield* Effect.forEach(Array.from({ length: spends }), () =>
        variant
          .balanceTransactions(secretKey, [transactionToBalance()], ttl)
          .pipe(Effect.map(({ transaction }) => transaction)),
      );
      const after = yield* SubscriptionRef.get(stateRef);
      return { transactions, pendingDust: after.pendingDust };
    }),
  );

// Under the test clock, and moved past the wallet's two-minute wait for a datable block, so a refusal arrives without
// the test sleeping through that wait.
const balanceUnderTestClock = (wallet: CoreWallet, spends = 1) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(balanceThroughVariant(wallet, spends));
      yield* TestClock.adjust("121 seconds");
      return yield* Fiber.await(fiber);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

const balanced = async (wallet: CoreWallet, spends = 1) => {
  const exit = await balanceUnderTestClock(wallet, spends);
  if (Exit.isFailure(exit)) {
    throw new Error(Cause.pretty(exit.cause));
  }
  return exit.value;
};

const refusal = async (wallet: CoreWallet): Promise<string | undefined> => {
  const exit = await balanceUnderTestClock(wallet);
  return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined;
};

describe("the faucet's dust variant declaring a spend's time", () => {
  it("declares the block the wallet last verified once the chain's trees have moved past it", async () => {
    const syncTime = behindTip(30_000);
    chainWith(
      { timestamp: tipTime, roots: movedOnRoots },
      { timestamp: syncTime, roots: rootsOf(dustStateWithCoins(syncTime)) },
    );

    const { transactions } = await balanced(walletAfterPassAt(syncTime));

    expect(transactions.map(declaredTimeOf)).toEqual([syncTime]);
  });

  it("declares that same block for back-to-back spends with no sync pass between them", async () => {
    const syncTime = behindTip(30_000);
    chainWith(
      { timestamp: tipTime, roots: movedOnRoots },
      { timestamp: syncTime, roots: rootsOf(dustStateWithCoins(syncTime)) },
    );

    const { transactions, pendingDust } = await balanced(walletAfterPassAt(syncTime), 2);

    expect(transactions.map(declaredTimeOf)).toEqual([syncTime, syncTime]);
    expect(pendingDust).toHaveLength(2);
  });

  it("declares the tip's time when the wallet's trees already hold the tip's roots", async () => {
    const syncTime = behindTip(30_000);
    const roots = rootsOf(dustStateWithCoins(syncTime));
    chainWith({ timestamp: tipTime, roots }, { timestamp: syncTime, roots });

    const { transactions } = await balanced(walletAfterPassAt(syncTime));

    expect(transactions.map(declaredTimeOf)).toEqual([tipTime]);
  });

  // Each of these used to go out dated at the tip and could fail at the node. Now the drip fails here instead,
  // after a wait that fits inside the drip's in-progress timeout.
  describe("refusing to date a spend at roots the wallet has not verified", () => {
    it("when sync has stalled and the block it last verified is too old to date from", async () => {
      const syncTime = behindTip(11 * 60 * 1_000);
      chainWith(
        { timestamp: tipTime, roots: movedOnRoots },
        { timestamp: syncTime, roots: rootsOf(dustStateWithCoins(syncTime)) },
      );

      expect(await refusal(walletAfterPassAt(syncTime))).toMatch(/No Dust spend can be dated yet/);
    });

    it("when the block it last verified does not hold the wallet's roots", async () => {
      const syncTime = behindTip(30_000);
      chainWith(
        { timestamp: tipTime, roots: movedOnRoots },
        { timestamp: syncTime, roots: movedOnRoots },
      );

      expect(await refusal(walletAfterPassAt(syncTime))).toMatch(/No Dust spend can be dated yet/);
    });

    it("before the wallet's first pass", async () => {
      chainWith({ timestamp: tipTime, roots: movedOnRoots });

      expect(
        await refusal(CoreWallet.init(dustStateWithCoins(new Date(0)), secretKey, networkId)),
      ).toMatch(/No Dust spend can be dated yet/);
    });
  });
});
