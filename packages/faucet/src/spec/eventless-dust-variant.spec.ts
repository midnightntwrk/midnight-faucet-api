import { describe, it, expect } from "vitest";
import { NetworkId, NoOpTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import { CustomDustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";

import {
  DustOptions,
  DUST_BACKGROUND_SYNC_INTERVAL_MS,
  eventlessDustVariantBuilder,
  type EventlessDustConfiguration,
} from "../WalletFactory.js";

/**
 * A `V2Builder` reports a missing capability only from `build()`, at runtime — the types accept a chain that is
 * still incomplete. Building the variant is therefore the only way to know the composition is whole, and it needs
 * no network: `CustomDustWallet` constructs capabilities from the configuration and connects to nothing.
 */
describe("eventlessDustVariantBuilder", () => {
  const configuration: EventlessDustConfiguration = {
    networkId: NetworkId.NetworkId.Undeployed,
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

  it("builds a complete variant", () => {
    // `withSync` clears the start-aux derivation the defaults installed, so a builder that swaps the sync service
    // and does not restate it fails here with "Not all components are configured in V2Builder: startAux".
    expect(() => CustomDustWallet(configuration, eventlessDustVariantBuilder())).not.toThrow();
  });

  it("derives the dust key from a seed, which is what the facade starts it with", () => {
    const Dust = CustomDustWallet(configuration, eventlessDustVariantBuilder());

    expect(() => Dust.startWithSeed(new Uint8Array(32))).not.toThrow();
  });
});
