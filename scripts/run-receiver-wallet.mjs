#!/usr/bin/env -S node --experimental-specifier-resolution=node
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import { firstValueFrom, filter, tap, throttleTime } from "rxjs";
import { HDWallet, Roles } from "@midnightntwrk/wallet-sdk-hd";
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { ZswapSecretKeys, DustSecretKey, LedgerParameters } from "@midnight-ntwrk/ledger-v8";
import { ShieldedAddress, UnshieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";

const networkId = NetworkId.NetworkId.Undeployed;

const configuration = {
  indexerClientConnection: {
    indexerHttpUrl: `http://localhost:8088/api/v3/graphql`,
    indexerWsUrl: `ws://localhost:8088/api/v3/graphql/ws`,
  },
  provingServerUrl: new URL(`http://localhost:6300`),
  relayURL: new URL(`ws://127.0.0.1:9944`),
  networkId,
  costParameters: {
    ledgerParams: LedgerParameters.initialParameters(),
    additionalFeeOverhead: 300_000_000_000_000n,
    feeBlocksMargin: 5,
  },
};

const masterSeed = "0000000000000000000000000000000000000000000000000000000000001111";

const getShieldedSeed = (seed) => {
  const seedBuffer = Buffer.from(seed, "hex");
  const { hdWallet } = HDWallet.fromSeed(seedBuffer);
  const derivationResult = hdWallet.selectAccount(0).selectRole(Roles.Zswap).deriveKeyAt(0);
  if (derivationResult.type === "keyOutOfBounds") throw new Error("Key derivation out of bounds");
  return derivationResult.key;
};

const getUnshieldedSeed = (seed) => {
  const seedBuffer = Buffer.from(seed, "hex");
  const { hdWallet } = HDWallet.fromSeed(seedBuffer);
  const derivationResult = hdWallet.selectAccount(0).selectRole(Roles.NightExternal).deriveKeyAt(0);
  if (derivationResult.type === "keyOutOfBounds") throw new Error("Key derivation out of bounds");
  return derivationResult.key;
};

const getDustSeed = (seed) => {
  const seedBuffer = Buffer.from(seed, "hex");
  const { hdWallet } = HDWallet.fromSeed(seedBuffer);
  const derivationResult = hdWallet.selectAccount(0).selectRole(Roles.Dust).deriveKeyAt(0);
  if (derivationResult.type === "keyOutOfBounds") throw new Error("Key derivation out of bounds");
  return derivationResult.key;
};

const shieldedSeed = getShieldedSeed(masterSeed);
const unshieldedSeed = getUnshieldedSeed(masterSeed);
const dustSeed = getDustSeed(masterSeed);

// Shielded wallet
const shielded = ShieldedWallet(configuration).startWithSeed(shieldedSeed);

// Unshielded wallet
const unshieldedKeystore = createKeystore(unshieldedSeed, networkId);
const unshielded = UnshieldedWallet({
  ...configuration,
  txHistoryStorage: new InMemoryTransactionHistoryStorage(),
}).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));

// Dust wallet
const dustParameters = LedgerParameters.initialParameters().dust;
const dust = DustWallet(configuration).startWithSeed(dustSeed, dustParameters);

// Create facade
const wallet = await WalletFacade.init({
  configuration,
  shielded: () => shielded,
  unshielded: () => unshielded,
  dust: () => dust,
});

console.log("Starting wallet...");
await wallet.start(ZswapSecretKeys.fromSeed(shieldedSeed), DustSecretKey.fromSeed(dustSeed));

// Print address immediately so we can send tokens to it
const initialState = await firstValueFrom(wallet.state());
const unshieldedAddress = UnshieldedAddress.codec
  .encode(networkId, initialState.unshielded.address)
  .asString();
const shieldedAddress = ShieldedAddress.codec
  .encode(networkId, initialState.shielded.address)
  .asString();
console.log("\n=== Receiver Wallet Addresses ===");
console.log("Unshielded:", unshieldedAddress);
console.log("Shielded:  ", shieldedAddress);
console.log("=================================\n");

console.log("Waiting for sync and available coins...");
const state = await firstValueFrom(
  wallet.state().pipe(
    throttleTime(5000),
    tap((state) => {
      console.log("Sync status:", {
        isSynced: state.isSynced,
        unshieldedAvailableCoins: state.unshielded.availableCoins.length,
        shieldedAvailableCoins: state.shielded.availableCoins.length,
      });
    }),
    filter(
      (state) =>
        state.isSynced === true &&
        (state.unshielded.availableCoins.length > 0 || state.shielded.availableCoins.length > 0),
    ),
  ),
);

const TNIGHT_DIVISOR = 1_000_000n;
const toTNight = (raw) =>
  `${raw / TNIGHT_DIVISOR}.${(raw % TNIGHT_DIVISOR).toString().padStart(6, "0")} tNight`;

const unshieldedRaw = state.unshielded.availableCoins.reduce(
  (acc, coin) => acc + coin.utxo.value,
  0n,
);
const shieldedRaw = state.shielded.availableCoins.reduce((acc, coin) => acc + coin.coin.value, 0n);

console.log("Wallet synced! State:", {
  unshieldedAddress: state.unshielded.address,
  shieldedAddress: state.shielded.address,
  unshieldedBalance: `${unshieldedRaw} (${toTNight(unshieldedRaw)})`,
  shieldedBalance: `${shieldedRaw} (${toTNight(shieldedRaw)})`,
  unshieldedCoins: state.unshielded.availableCoins.length,
  shieldedCoins: state.shielded.availableCoins.length,
});
