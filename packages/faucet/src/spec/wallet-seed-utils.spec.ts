import { describe, it, expect } from "vitest";
import * as WalletSeedUtils from "../WalletSeedUtils.js";

describe("WalletSeedUtils", () => {
  // A valid 64-byte seed (BIP-32 requires 16-64 bytes)
  const validSeed = new Uint8Array(64).fill(1);

  describe("with valid seed", () => {
    it("getShieldedSeed returns a Uint8Array", () => {
      const result = WalletSeedUtils.getShieldedSeed(validSeed);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBeGreaterThan(0);
    });

    it("getUnshieldedSeed returns a Uint8Array", () => {
      const result = WalletSeedUtils.getUnshieldedSeed(validSeed);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBeGreaterThan(0);
    });

    it("getDustSeed returns a Uint8Array", () => {
      const result = WalletSeedUtils.getDustSeed(validSeed);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBeGreaterThan(0);
    });

    it("derives different seeds for different roles", () => {
      const shielded = WalletSeedUtils.getShieldedSeed(validSeed);
      const unshielded = WalletSeedUtils.getUnshieldedSeed(validSeed);
      const dust = WalletSeedUtils.getDustSeed(validSeed);

      // All three should be different
      expect(Buffer.from(shielded).toString("hex")).not.toBe(
        Buffer.from(unshielded).toString("hex"),
      );
      expect(Buffer.from(shielded).toString("hex")).not.toBe(Buffer.from(dust).toString("hex"));
      expect(Buffer.from(unshielded).toString("hex")).not.toBe(Buffer.from(dust).toString("hex"));
    });
  });

  describe("with invalid seed", () => {
    it("getShieldedSeed throws a clear error for too-short seed", () => {
      const shortSeed = new Uint8Array(4);
      expect(() => WalletSeedUtils.getShieldedSeed(shortSeed)).toThrow("HD wallet seed error");
    });

    it("getUnshieldedSeed throws a clear error for too-short seed", () => {
      const shortSeed = new Uint8Array(4);
      expect(() => WalletSeedUtils.getUnshieldedSeed(shortSeed)).toThrow("HD wallet seed error");
    });

    it("getDustSeed throws a clear error for too-short seed", () => {
      const shortSeed = new Uint8Array(4);
      expect(() => WalletSeedUtils.getDustSeed(shortSeed)).toThrow("HD wallet seed error");
    });

    it("throws for empty seed", () => {
      const emptySeed = new Uint8Array(0);
      expect(() => WalletSeedUtils.getShieldedSeed(emptySeed)).toThrow("HD wallet seed error");
    });
  });
});
