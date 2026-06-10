import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { doCheck, checkNode, checkIndexer, checkProofServer } from "../WalletFactory.js";
import pino from "pino";
import { URL } from "node:url";

describe("Health check functions", () => {
  let logger: pino.Logger;

  beforeEach(() => {
    logger = pino({ level: "silent" });
  });

  describe("doCheck", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should successfully check a healthy endpoint", async () => {
      const mockResponse = new Response(null, { status: 200 });
      vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse);

      const healthcheckURL = new URL("http://localhost:8000/health");
      const checker = doCheck("test-service", healthcheckURL);

      const result = await checker(logger);
      expect(result.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(healthcheckURL);
    });

    it("should fail when endpoint returns non-ok status", async () => {
      const mockResponse = new Response(null, { status: 503 });
      vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse);

      const healthcheckURL = new URL("http://localhost:8000/health");
      const checker = doCheck("test-service", healthcheckURL);

      await expect(checker(logger)).rejects.toThrow(
        /Healthcheck from test-service.*failed with status 503/,
      );
    });

    it("should fail when fetch throws an error", async () => {
      const error = new Error("Network error");
      vi.spyOn(global, "fetch").mockRejectedValueOnce(error);

      const healthcheckURL = new URL("http://localhost:8000/health");
      const checker = doCheck("test-service", healthcheckURL);

      await expect(checker(logger)).rejects.toThrow("Network error");
    });

    it("should include service name and URL in error message", async () => {
      const mockResponse = new Response(null, { status: 502 });
      vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse);

      const healthcheckURL = new URL("https://example.com:9000/api/health");
      const checker = doCheck("my-service", healthcheckURL);

      await expect(checker(logger)).rejects.toThrow(
        /my-service.*https:\/\/example\.com:9000\/api\/health.*502/,
      );
    });

    it("should handle various HTTP error statuses", async () => {
      const statuses = [400, 401, 403, 404, 500, 501, 504];

      for (const status of statuses) {
        vi.clearAllMocks();
        const mockResponse = new Response(null, { status });
        vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse);

        const healthcheckURL = new URL("http://localhost:8000/health");
        const checker = doCheck("test", healthcheckURL);

        await expect(checker(logger)).rejects.toThrow(`status ${status}`);
      }
    });
  });

  describe("checkNode", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should create correct health endpoint URL for node", async () => {
      const mockResponse = new Response(
        JSON.stringify({ isSyncing: true, shouldHavePeers: false }),
        { status: 200 },
      );
      vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse);

      const nodeURL = new URL("http://localhost:9944");
      const checker = checkNode(nodeURL);

      await checker(logger);

      expect(global.fetch).toHaveBeenCalledWith(new URL("/health", nodeURL));
    });

    it("should handle node URL with path", async () => {
      const mockResponse = new Response(
        JSON.stringify({ isSyncing: true, shouldHavePeers: false }),
        { status: 200 },
      );
      vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse);

      const nodeURL = new URL("http://localhost:9944/some/path");
      const checker = checkNode(nodeURL);

      await checker(logger);

      const expectedURL = new URL("/health", nodeURL);
      expect(global.fetch).toHaveBeenCalledWith(expectedURL);
    });

    it("should fail with appropriate error message when node is unhealthy", async () => {
      const mockResponse = new Response(null, { status: 503 });
      vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse);

      const nodeURL = new URL("ws://localhost:9944");
      const checker = checkNode(nodeURL);

      await expect(checker(logger)).rejects.toThrow(/Node healthcheck failed/i);
    });
  });

  describe("checkIndexer", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should create correct health endpoint URL for indexer", async () => {
      const mockResponse = new Response(null, { status: 200 });
      vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse);

      const indexerURL = new URL("wss://localhost:8088");
      const checker = checkIndexer(indexerURL);

      await checker(logger);

      expect(global.fetch).toHaveBeenCalledWith(new URL("/ready", indexerURL));
    });

    it("should handle indexer URL with existing path", async () => {
      const mockResponse = new Response(null, { status: 200 });
      vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse);

      const indexerURL = new URL("wss://localhost:8088/api");
      const checker = checkIndexer(indexerURL);

      await checker(logger);

      const expectedURL = new URL("/ready", indexerURL);
      expect(global.fetch).toHaveBeenCalledWith(expectedURL);
    });

    it("should fail with appropriate error message when indexer is not ready", async () => {
      const mockResponse = new Response(null, { status: 503 });
      vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse);

      const indexerURL = new URL("wss://localhost:8088");
      const checker = checkIndexer(indexerURL);

      await expect(checker(logger)).rejects.toThrow(/indexer.*ready/);
    });
  });

  describe("checkProofServer", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should create correct health endpoint URL for proof server", async () => {
      const mockResponse = new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse);

      const proofServerURL = new URL("http://localhost:6300");
      const checker = checkProofServer(proofServerURL);

      await checker(logger);

      expect(global.fetch).toHaveBeenCalledWith(new URL("/health", proofServerURL));
    });

    it("should handle proof server URL with port and path", async () => {
      const mockResponse = new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse);

      const proofServerURL = new URL("https://proof.example.com:6300/api");
      const checker = checkProofServer(proofServerURL);

      await checker(logger);

      const expectedURL = new URL("/health", proofServerURL);
      expect(global.fetch).toHaveBeenCalledWith(expectedURL);
    });

    it("should fail with appropriate error message when proof server is unhealthy", async () => {
      const mockResponse = new Response(null, { status: 500 });
      vi.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse);

      const proofServerURL = new URL("http://localhost:6300");
      const checker = checkProofServer(proofServerURL);

      await expect(checker(logger)).rejects.toThrow(/Proof server healthcheck failed/i);
    });
  });
});
