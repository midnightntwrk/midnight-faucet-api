import { describe, it, expect } from "vitest";
import { isCorruptedStateError } from "../WalletFactory.js";

describe("isCorruptedStateError", () => {
  it("returns true for Wallet.Other with non-linearly inserted commitment tree error", () => {
    const error = {
      _tag: "Wallet.Other",
      cause: new Error(
        "values inserted non-linearly into zswap commitment tree; expected to insert index 50, but received 38.",
      ),
    };
    expect(isCorruptedStateError(error)).toBe(true);
  });

  it("returns false for Wallet.Other with a different cause message", () => {
    const error = {
      _tag: "Wallet.Other",
      cause: new Error("some other wallet error"),
    };
    expect(isCorruptedStateError(error)).toBe(false);
  });

  it("returns false for Wallet.Sync errors", () => {
    const error = {
      _tag: "Wallet.Sync",
      cause: new Error("values inserted non-linearly into zswap commitment tree"),
    };
    expect(isCorruptedStateError(error)).toBe(false);
  });

  it("returns false for Wallet.Error errors", () => {
    const error = {
      _tag: "Wallet.Error",
      cause: new Error("values inserted non-linearly into zswap commitment tree"),
    };
    expect(isCorruptedStateError(error)).toBe(false);
  });

  it("returns false when cause is not an Error instance", () => {
    const error = {
      _tag: "Wallet.Other",
      cause: "values inserted non-linearly into zswap commitment tree",
    };
    expect(isCorruptedStateError(error)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isCorruptedStateError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isCorruptedStateError(undefined)).toBe(false);
  });

  it("returns false for plain Error", () => {
    expect(isCorruptedStateError(new Error("something"))).toBe(false);
  });

  it("returns false for non-object values", () => {
    expect(isCorruptedStateError("string")).toBe(false);
    expect(isCorruptedStateError(42)).toBe(false);
  });

  it("returns false when _tag is missing", () => {
    const error = {
      cause: new Error("values inserted non-linearly into zswap commitment tree"),
    };
    expect(isCorruptedStateError(error)).toBe(false);
  });
});
