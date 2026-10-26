import { describe, it, expect } from "vitest";
import { STARS_PER_NIGHT, starToWholeTNight } from "../units.js";

describe("STARS_PER_NIGHT", () => {
  // Pinned against the default `dropAmount` of 5,000,000,000 and the page's
  // "5000 tNight" copy, which are what this factor has to reconcile.
  it("divides the default dropAmount into the 5000 tNIGHT the page promises", () => {
    expect(STARS_PER_NIGHT).toBe(1_000_000n);
    expect(5_000_000_000n / STARS_PER_NIGHT).toBe(5000n);
  });
});

describe("starToWholeTNight", () => {
  it("renders the default dropAmount as the 5000 the page promises", () => {
    expect(starToWholeTNight(5_000_000_000n)).toBe("5000");
  });

  it("does not group thousands, so the page copy reads as it always has", () => {
    expect(starToWholeTNight(1_000_000_000n)).toBe("1000");
  });

  it("truncates a drop that is not a whole tNIGHT rather than rounding up", () => {
    expect(starToWholeTNight(1_999_999n)).toBe("1");
  });
});
