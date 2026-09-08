import { ServerConfig } from "../config.js";
import { transformURLs } from "../faucet.js";

const configWithIndexerURL = (indexerURL: URL): ServerConfig["urls"] => ({
  indexer: indexerURL,
  node: new URL("http://localhost:9933"),
  provingServer: new URL("http://localhost:6300"),
});

describe("Faucet configuration", () => {
  describe("handling PubSub subscription protocol", () => {
    it("uses WS for HTTP setting", () => {
      const serverConfigURLs = configWithIndexerURL(
        new URL("http://localhost:8088/api/v3/graphql"),
      );

      const actual = transformURLs(serverConfigURLs);

      expect(actual.indexerURL).toEqual(serverConfigURLs.indexer);
      expect(actual.indexerSubscriptionURL.toString()).toEqual(
        "ws://localhost:8088/api/v3/graphql/ws",
      );
    });

    it("uses WSS for HTTPS setting", () => {
      const serverConfigURLs = configWithIndexerURL(
        new URL("https://localhost:8088/api/v3/graphql"),
      );

      const actual = transformURLs(serverConfigURLs);

      expect(actual.indexerURL).toEqual(serverConfigURLs.indexer);
      expect(actual.indexerSubscriptionURL.toString()).toEqual(
        "wss://localhost:8088/api/v3/graphql/ws",
      );
    });

    it.each([
      {
        provided: "https://localhost:8088/api/v4/graphql",
        expected: "wss://localhost:8088/api/v4/graphql/ws",
      },
      {
        provided: "https://localhost/api/v4/graphql",
        expected: "wss://localhost/api/v4/graphql/ws",
      },
      {
        provided: "http://localhost:8088/api/v4/graphql",
        expected: "ws://localhost:8088/api/v4/graphql/ws",
      },
      { provided: "http://localhost/api/v4/graphql", expected: "ws://localhost/api/v4/graphql/ws" },
      { provided: "http://localhost:8088/foo", expected: "ws://localhost:8088/foo/ws" },
      { provided: "http://localhost:8088/foo/", expected: "ws://localhost:8088/foo/ws" },
      { provided: "http://localhost:8088/foo/1", expected: "ws://localhost:8088/foo/1/ws" },
    ])("adds /ws to the pathname of url $provided", ({ provided, expected }) => {
      const serverConfigURLs = configWithIndexerURL(new URL(provided));

      const actual = transformURLs(serverConfigURLs);

      expect(actual.indexerURL).toEqual(serverConfigURLs.indexer);
      expect(actual.indexerSubscriptionURL.toString()).toEqual(expected);
    });
  });
});
