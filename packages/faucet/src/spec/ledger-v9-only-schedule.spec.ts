import { describe, it, expect } from "vitest";
import { ProtocolVersion, WalletTransaction } from "@midnightntwrk/wallet-sdk-abstractions";
import { DefaultForkSchedule } from "@midnightntwrk/wallet-sdk-facade";

import { LedgerV9OnlySchedule } from "../WalletFactory.js";

/**
 * The faucet composes single-variant wallets so its dust wallet can use the projections ("eventless") sync, which
 * exists on ledger-v9 only. Those wallets register at — and stamp every transaction at — the minimum supported
 * version, and the facade picks its ledger and its accept-range from the fork schedule alone. So the schedule is
 * what keeps the whole composition on ledger-v9; these tests pin that rather than the schedule's literal value.
 */
describe("LedgerV9OnlySchedule", () => {
  const epoch = ProtocolVersion.epochOf(LedgerV9OnlySchedule.v9, LedgerV9OnlySchedule.v9);

  // What a single-variant wallet stamps its transactions at.
  const floorStamped = ProtocolVersion.MinSupportedVersion;
  // What a v9-native chain reports, and what a snapshot written by the forking wallet carries.
  const chainReported = ProtocolVersion.V9NativeForkVersion;

  it("collapses the timeline to a single epoch", () => {
    expect(epoch).toEqual([
      ProtocolVersion.MinSupportedVersion,
      ProtocolVersion.MaxSupportedVersion,
    ]);
  });

  it("puts both the version wallets stamp and the version the chain reports in that epoch", () => {
    expect(ProtocolVersion.withinRange(floorStamped, epoch)).toBe(true);
    expect(ProtocolVersion.withinRange(chainReported, epoch)).toBe(true);
  });

  it("never resolves to ledger-v8 authoring", () => {
    // The facade's rule is `currentVersion() < forkVersion ? v8Authoring : v9Authoring`, and `currentVersion()`
    // is the lowest version the three wallets report — which bottoms out at the floor.
    expect(floorStamped < LedgerV9OnlySchedule.v9).toBe(false);
    expect(chainReported < LedgerV9OnlySchedule.v9).toBe(false);
  });

  it("accepts a transaction sealed at the floor, which DefaultForkSchedule would refuse", () => {
    const handle = WalletTransaction.adopt(
      "Finalized",
      { serialize: () => new Uint8Array() },
      floorStamped,
    );

    expect(WalletTransaction.unwrapWithin(handle, epoch)._tag).toBe("Right");

    // The reason this schedule exists: under the default schedule the facade's epoch is the post-fork range, so
    // the handles the faucet's own wallets produce fall outside it and every merge of a balancing transaction
    // fails. Swapping the schedule back silently reintroduces that.
    const defaultEpoch = ProtocolVersion.epochOf(DefaultForkSchedule.v9, DefaultForkSchedule.v9);
    expect(ProtocolVersion.withinRange(floorStamped, defaultEpoch)).toBe(false);
    expect(WalletTransaction.unwrapWithin(handle, defaultEpoch)._tag).toBe("Left");
  });
});
