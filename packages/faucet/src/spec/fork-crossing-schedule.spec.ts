import { describe, it, expect } from "vitest";
import { ProtocolVersion } from "@midnightntwrk/wallet-sdk-abstractions";

import { ForkCrossingSchedule, LedgerV9OnlySchedule } from "../WalletFactory.js";

/**
 * The shielded wallet is the one wallet in the faucet that replays the chain's event log, so unlike the facade and
 * the dust wallet it cannot run on a schedule whose boundary sits at the floor. These tests pin the distinction
 * using the versions devnet actually reports, because the failure this schedule fixes was invisible in every
 * property of the schedule itself — it only showed up as two versions sharing an epoch that must not share one.
 *
 * Companion to `ledger-v9-only-schedule.spec.ts`, which pins the opposite requirement for the facade.
 */
describe("ForkCrossingSchedule", () => {
  // Measured from devnet on 2026-10-02: it forked in place at block 169496, so its history spans both epochs.
  const devnetPreFork = ProtocolVersion.ProtocolVersion(1_000_300n);
  const devnetPostFork = ProtocolVersion.ProtocolVersion(2_001_000n);

  const crossingEpochOf = (version: ProtocolVersion.ProtocolVersion) =>
    ProtocolVersion.epochOf(version, ForkCrossingSchedule.v9);

  it("keeps a real boundary rather than collapsing to one epoch", () => {
    expect(ForkCrossingSchedule.v9).toBeGreaterThan(ProtocolVersion.MinSupportedVersion);
  });

  it("separates devnet's pre-fork history from its post-fork history", () => {
    expect(crossingEpochOf(devnetPreFork)).not.toEqual(crossingEpochOf(devnetPostFork));
  });

  it("assigns devnet's pre-fork history to the ledger-v8 side", () => {
    expect(devnetPreFork < ForkCrossingSchedule.v9).toBe(true);
    expect(ProtocolVersion.withinRange(devnetPreFork, crossingEpochOf(devnetPostFork))).toBe(false);
  });

  it("assigns devnet's post-fork history to the ledger-v9 side", () => {
    expect(devnetPostFork < ForkCrossingSchedule.v9).toBe(false);
  });

  it("holds even though devnet enacted its hand-over above the boundary", () => {
    // devnet jumps 1000300 -> 2001000 and never reports 2000000 itself. The boundary does not have to be a version
    // the chain emits; it only has to fall between the two epochs.
    expect(
      devnetPreFork < ForkCrossingSchedule.v9 && ForkCrossingSchedule.v9 <= devnetPostFork,
    ).toBe(true);
  });

  it("is the distinction the facade's collapsed schedule cannot make", () => {
    // The bug, stated as a test: under the floor boundary both of devnet's epochs are one epoch, so the shielded
    // wallet believes it owns the pre-fork span and reads it with the ledger-v9 reader.
    const collapsed = (version: ProtocolVersion.ProtocolVersion) =>
      ProtocolVersion.epochOf(version, LedgerV9OnlySchedule.v9);

    expect(collapsed(devnetPreFork)).toEqual(collapsed(devnetPostFork));
  });
});
