import { afterEach, describe, expect, it, vi } from "vitest";

import { isIndexerPastGenesis } from "../indexer-past-genesis.js";

const indexerURL = new URL("http://indexer.test/api/v4/graphql");

const respondingWith = (body: unknown) =>
  vi.fn((_url: URL, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify(body))));

describe("isIndexerPastGenesis", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is false while the indexer's latest block is genesis", async () => {
    vi.stubGlobal("fetch", respondingWith({ data: { block: { height: 0 } } }));

    await expect(isIndexerPastGenesis(indexerURL)).resolves.toBe(false);
  });

  it("is true once the indexer has indexed block 1", async () => {
    const fetch = respondingWith({ data: { block: { height: 1 } } });
    vi.stubGlobal("fetch", fetch);

    await expect(isIndexerPastGenesis(indexerURL)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      indexerURL,
      expect.objectContaining({ method: "POST", body: '{"query":"{ block { height } }"}' }),
    );
  });

  it("is false when the indexer cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );

    await expect(isIndexerPastGenesis(indexerURL)).resolves.toBe(false);
  });

  it("is false when the response carries no block height", async () => {
    vi.stubGlobal("fetch", respondingWith({ errors: [{ message: "Unknown field" }] }));

    await expect(isIndexerPastGenesis(indexerURL)).resolves.toBe(false);
  });
});
