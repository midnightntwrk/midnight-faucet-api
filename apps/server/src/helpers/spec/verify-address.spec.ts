import { InvalidAddressError, verifyAddress } from "../verify-address";
import { describe, it, expect, vi } from "vitest";
import { NetworkId } from "@midnight-ntwrk/wallet-sdk-abstractions";

vi.mock("./wherever/MidnightBech32m", () => ({
  MidnightBech32m: {
    parse: vi.fn(),
  },
}));

describe("InvalidAddressError", () => {
  it("sets the message and keeps the failing address", () => {
    const err = new InvalidAddressError("bad_address");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InvalidAddressError);
    expect(err.message).toBe("Provided address is invalid");
    expect(err.address).toBe("bad_address");
  });
});

// Valid addresses
const validAddresses = [
  // Valid Preview unshielded address
  {
    address: "mn_addr_preview1dfge7ar5mg47h5ytu9axnh6m59ed2m7azvx0ejarlthtvwyeaueqt4qktd",
    networkId: NetworkId.NetworkId.Preview,
  },
  {
    address: "mn_addr_undeployed1qpfkp8dd8xpv57t3sf0p5cex8a37qz40kjlz7hke3aq6mfk2pkyshz6pq0",
    networkId: NetworkId.NetworkId.Undeployed,
  },
];

// Invalid addresses and why
const invalidAddresses: string[] = [
  // unsupported network
  "mn_shield-addr_dddds8cv5nz4pw45ane8lhccv7eamvvfkxdhshjew3t4zlej479j6auqxqzqfn89wwz7h3hayrhwlcvu6tutnuc3kllr4nvj26lncwjugsehmvgvuca8",

  // unshielded: wrong network
  "mn_unshielded-addr_test1s8cv5nz4pw45ane8lhccv7eamvvfkxdhshjew3t4zlej479j6auqxqzqfn89wwz7h3hayrhwlcvu6tutnuc3kllr4nvj26lncwjugsehmvgvuca8",

  // encrypted address too long
  "mn_unshielded-addr_test1s8cv5nz4pw45ane8lhccv7eamvvfkxdhshjew3t4zlej479j6auqxqzqfn89wwz7h3hayrhwlcvu6tutnuc3kllr4nvj26lncwjugsehmvgvuaaaasdasdccca8",

  // encrypted address too short
  "mn_shield-addr_test1s8cv5nz4pw45ane8lhccv7eamvvfkxdhshjew3t4zlej479j6auqxqzqfn89wwz7h3hayrhwlcvu6tutnuc3kllr4nvj26lncwjugsehmv",
];

describe("verifyAddress", () => {
  it.each(validAddresses)("accepts valid address: %s", ({ address, networkId }) => {
    expect(() => verifyAddress({ unshieldedAddress: address, networkId })).not.toThrow();
  });

  it.each(invalidAddresses)("throws InvalidAddressError for %s", (addr: string) => {
    // Should throw our custom error
    expect(() =>
      verifyAddress({ unshieldedAddress: addr, networkId: NetworkId.NetworkId.Undeployed }),
    ).toThrowError(InvalidAddressError);

    // Check the `address` property of the error
    let caught: unknown;
    try {
      verifyAddress({ unshieldedAddress: addr, networkId: NetworkId.NetworkId.Undeployed });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidAddressError);
    expect((caught as InvalidAddressError).address).toBe(addr);
  });
});
