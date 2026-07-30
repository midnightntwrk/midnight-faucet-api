import { describe, it, expect, vi, beforeEach } from "vitest";
import { BehaviorSubject, firstValueFrom } from "rxjs";
import pino from "pino";
import { createKeystore } from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { unshieldedToken } from "@midnightntwrk/ledger-v9";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";

import { FaucetConfig, InsufficientFundsError, mkRequestTokens } from "../FaucetImpl.js";
import type { FaucetWallet } from "../WalletFactory.js";
import * as WalletSeedUtils from "../WalletSeedUtils.js";

const TX_HASH = "txhash-abc";

const logger = pino({ level: "silent" });

const config: FaucetConfig<unknown> = {
  networkId: NetworkId.NetworkId.Undeployed,
  dropAmount: "1000",
  targetCoinNumber: 1,
  targetCoinSizeFactor: 10n,
  walletSeed: Buffer.alloc(32, 7),
  numberOfOutputs: 1,
  walletConfig: {},
};

// A valid, decodable receiver address for the configured network.
const receiverAddress = createKeystore(
  { kind: "schnorr", secret: WalletSeedUtils.getUnshieldedSeed(Buffer.alloc(32, 9)) },
  NetworkId.NetworkId.Undeployed,
)
  .getBech32Address()
  .asString();

type Utxo = { intentHash: string; outputNo: number; value: bigint };
type UnshieldedCoin = { utxo: Utxo };

const makeCoin = (intentHash: string, outputNo: number, value: bigint): UnshieldedCoin => ({
  utxo: { intentHash, outputNo, value },
});

const sameCoin = (a: UnshieldedCoin, b: UnshieldedCoin) =>
  a.utxo.intentHash === b.utxo.intentHash && a.utxo.outputNo === b.utxo.outputNo;

const progress = { isCompleteWithin: () => true };

const buildState = (available: UnshieldedCoin[], pending: UnshieldedCoin[]) => ({
  shielded: {
    address: new Uint8Array(32),
    balances: {},
    availableCoins: [],
    totalCoins: [],
    pendingCoins: [],
    progress,
  },
  unshielded: {
    address: new Uint8Array(32),
    balances: { [unshieldedToken().raw]: available.reduce((acc, c) => acc + c.utxo.value, 0n) },
    availableCoins: available,
    totalCoins: [...available, ...pending],
    pendingCoins: pending,
    progress,
  },
  dust: {
    availableCoins: [],
    totalCoins: [],
    pendingCoins: [],
    balance: () => 0n,
    progress,
  },
});

/**
 * Fake wallet that reproduces the wallet SDK's reserve-on-transfer semantics:
 * building a transfer moves the selected available coins into `pending`, and
 * `revert` releases them back to `available`.
 */
const makeFakeWallet = (available: UnshieldedCoin[]) => {
  const subject = new BehaviorSubject(buildState(available, []));
  let reserved: UnshieldedCoin[] = [];

  const wallet = {
    transferError: null as Error | null,
    submitError: null as Error | null,
    signError: null as Error | null,
    revertError: null as Error | null,

    state: () => subject.asObservable(),

    transferTransaction: () => {
      if (wallet.transferError) return Promise.reject(wallet.transferError);
      const s = subject.getValue();
      reserved = s.unshielded.availableCoins;
      subject.next(buildState([], [...s.unshielded.pendingCoins, ...reserved]));
      return Promise.resolve({ type: "UNPROVEN_TRANSACTION", transaction: {} });
    },

    signRecipe: (recipe: unknown) =>
      wallet.signError ? Promise.reject(wallet.signError) : Promise.resolve(recipe),

    finalizeRecipe: () => Promise.resolve({ transactionHash: () => ({ toString: () => TX_HASH }) }),

    submitTransaction: () =>
      wallet.submitError ? Promise.reject(wallet.submitError) : Promise.resolve(TX_HASH),

    queryTxHistoryByHash: () => Promise.resolve({ status: "SUCCESS" }),

    revert: vi.fn((_recipe: unknown) => {
      if (wallet.revertError) return Promise.reject(wallet.revertError);
      const s = subject.getValue();
      const restored = reserved;
      reserved = [];
      const availableCoins = [...s.unshielded.availableCoins, ...restored];
      const pending = s.unshielded.pendingCoins.filter(
        (c) => !restored.some((r) => sameCoin(r, c)),
      );
      subject.next(buildState(availableCoins, pending));
      return Promise.resolve();
    }),
  };

  return wallet;
};

// The fake implements only the slice of FaucetWallet that mkRequestTokens touches;
// this keeps that (unavoidable) narrowing in one named place instead of scattering casts.
const asWallet = (w: ReturnType<typeof makeFakeWallet>): FaucetWallet =>
  w as unknown as FaucetWallet;

describe("mkRequestTokens - coin reservation handling", () => {
  let wallet: ReturnType<typeof makeFakeWallet>;
  let requestTokens: ReturnType<typeof mkRequestTokens>;

  beforeEach(() => {
    wallet = makeFakeWallet([makeCoin("aa", 0, 5_000_000_000n), makeCoin("bb", 0, 5_000_000_000n)]);
    requestTokens = mkRequestTokens(logger, config, asWallet(wallet));
  });

  it("returns a transaction hash when the wallet has exactly enough available coins", async () => {
    const response = await requestTokens(receiverAddress);

    expect(response.transactionIdentifier).toBe(TX_HASH);
  });

  it("releases reserved coins back to available when submission fails, instead of leaving them stuck in pending", async () => {
    wallet.submitError = new Error("submit boom");

    await expect(requestTokens(receiverAddress)).rejects.toThrow("submit boom");

    expect(wallet.revert).toHaveBeenCalledTimes(1);
    const finalState = await firstValueFrom(wallet.state());
    expect(finalState.unshielded.availableCoins).toHaveLength(2);
    expect(finalState.unshielded.pendingCoins).toHaveLength(0);
  });

  it("releases reserved coins when a pre-submit step fails (reserved but never submitted)", async () => {
    // Fail after transferTransaction has reserved the coins but before submit.
    wallet.signError = new Error("sign boom");

    await expect(requestTokens(receiverAddress)).rejects.toThrow("sign boom");

    expect(wallet.revert).toHaveBeenCalledTimes(1);
    const finalState = await firstValueFrom(wallet.state());
    expect(finalState.unshielded.availableCoins).toHaveLength(2);
    expect(finalState.unshielded.pendingCoins).toHaveLength(0);
  });

  it("propagates the original failure, not the revert error, when releasing reserved coins itself fails", async () => {
    wallet.submitError = new Error("submit boom");
    wallet.revertError = new Error("revert boom");

    // The revert failure is logged and swallowed so the caller still sees the real cause.
    await expect(requestTokens(receiverAddress)).rejects.toThrow("submit boom");

    expect(wallet.revert).toHaveBeenCalledTimes(1);
  });

  it("maps a wallet balancing failure to InsufficientFundsError without reverting (nothing was reserved)", async () => {
    // transferTransaction fails to balance — no coins are reserved, so there is nothing to release.
    wallet.transferError = new Error("Not sufficient funds to balance token: night");

    await expect(requestTokens(receiverAddress)).rejects.toBeInstanceOf(InsufficientFundsError);

    expect(wallet.revert).not.toHaveBeenCalled();
    const finalState = await firstValueFrom(wallet.state());
    expect(finalState.unshielded.availableCoins).toHaveLength(2);
    expect(finalState.unshielded.pendingCoins).toHaveLength(0);
  });
});
