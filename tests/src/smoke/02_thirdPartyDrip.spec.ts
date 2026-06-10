import axios from "axios";
import * as utils from "../e2e/setup/utils";
import { useTestContainersFixture } from "./test-fixture";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { describe, expect, beforeAll, afterAll, test } from "vitest";
import { randomBytes } from "node:crypto";
import { NetworkId } from "@midnight-ntwrk/wallet-sdk-abstractions";

interface HealthResponse {
  status: string;
  reason: string | null;
}

interface DripResponse {
  dripId: string;
  status: string;
  transactionHash: string | null;
  error: string | null;
}

interface ErrorResponse {
  error: string;
}

describe("Third-Party API Smoke Tests", () => {
  const getFixture = useTestContainersFixture();
  const seed = randomBytes(32).toString("hex");
  const shieldedSecretKey = ledger.ZswapSecretKeys.fromSeed(utils.getShieldedSeed(seed));
  const dustSecretKey = ledger.DustSecretKey.fromSeed(utils.getDustSeed(seed));
  const unshieldedTokenRaw = ledger.unshieldedToken().raw;
  const requestedDripAmount = "1000";
  const timeout = 60 * 60 * 1000; // 60 minutes

  let wallet: WalletFacade;
  let faucetUrl: string;
  let networkId: NetworkId.NetworkId;
  let walletAddress: string;
  let dripId: string;
  let unshieldedBalanceInitial: bigint;

  const origin = "http://localhost:5300";
  const apiKey = process.env.THIRD_PARTY_API_KEY ?? "";

  if (!apiKey) {
    throw new Error(
      "THIRD_PARTY_API_KEY environment variable is required but was empty or not set",
    );
  }

  const thirdPartyHeaders = {
    Origin: origin,
    "X-API-Key": apiKey,
  };

  const acceptAllStatuses = { validateStatus: () => true };

  beforeAll(async () => {
    const fixture = getFixture();
    const walletConfig = fixture.getWalletConfig();
    networkId = walletConfig.networkId;
    faucetUrl = fixture.getFaucetUrl();
    wallet = await utils.buildWalletFacade(seed, walletConfig);
    await wallet.start(shieldedSecretKey, dustSecretKey);

    const state = await utils.waitForUnshieldedSync(wallet);
    walletAddress = utils.getUnshieldedAddress(networkId, state.unshielded.address);
    unshieldedBalanceInitial = state.unshielded.balances[unshieldedTokenRaw] ?? 0n;
    console.log(`Wallet address: ${walletAddress}`);
    console.log(`Initial unshielded balance: ${unshieldedBalanceInitial}`);
  }, timeout);

  afterAll(async () => {
    await wallet.stop();
  }, timeout);

  describe("GET /v1/health", () => {
    test("Health check returns SERVING status", async () => {
      const maxRetries = 10;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const response = await axios.get<HealthResponse>(`${faucetUrl}/v1/health`, {
            headers: thirdPartyHeaders,
            timeout: 5000,
          });

          expect(response.status).toBe(200);
          expect(response.data.status).toBe("SERVING");
          expect(response.data.reason).toBeNull();
          console.log("Third-party health status:", response.data);
          return;
        } catch (error) {
          lastError = error;
          console.log(`Health check attempt ${attempt}/${maxRetries} failed, retrying in 5s...`);
          if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 5000));
        }
      }
      throw lastError;
    }, 60_000);

    test("Health check returns 403 without Origin header", async () => {
      const response = await axios.get(`${faucetUrl}/v1/health`, {
        headers: { "X-API-Key": apiKey },
        ...acceptAllStatuses,
      });
      expect(response.status).toBe(403);
    }, 20_000);

    test("Health check returns 403 for non-whitelisted Origin", async () => {
      const response = await axios.get(`${faucetUrl}/v1/health`, {
        headers: {
          Origin: "https://unauthorized-domain.com",
          "X-API-Key": apiKey,
        },
        ...acceptAllStatuses,
      });
      expect(response.status).toBe(403);
    }, 20_000);

    test("Health check returns 401 without API key", async () => {
      const response = await axios.get(`${faucetUrl}/v1/health`, {
        headers: { Origin: origin },
        ...acceptAllStatuses,
      });
      expect(response.status).toBe(401);
    }, 20_000);

    test("Health check returns 403 with invalid API key", async () => {
      const response = await axios.get(`${faucetUrl}/v1/health`, {
        headers: {
          Origin: origin,
          "X-API-Key": "invalid-api-key",
        },
        ...acceptAllStatuses,
      });
      expect(response.status).toBe(403);
    }, 20_000);
  });

  describe("POST /v1/drips", () => {
    test(
      "Request drip returns dripId with PENDING status",
      async () => {
        const response = await axios.post<DripResponse>(
          `${faucetUrl}/v1/drips`,
          {
            recipientAddress: walletAddress,
            amount: requestedDripAmount,
          },
          {
            headers: {
              ...thirdPartyHeaders,
              "Content-Type": "application/json",
            },
          },
        );

        expect(response.status).toBe(200);
        expect(response.data.dripId).toBeDefined();
        expect(typeof response.data.dripId).toBe("string");
        expect(response.data.status).toBe("PENDING");
        expect(response.data.transactionHash).toBeNull();
        expect(response.data.error).toBeNull();

        dripId = response.data.dripId;
        console.log(`Drip requested successfully, dripId=${dripId}`);
      },
      timeout,
    );

    test("Request drip returns 403 without Origin header", async () => {
      const response = await axios.post(
        `${faucetUrl}/v1/drips`,
        { recipientAddress: walletAddress, amount: requestedDripAmount },
        {
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": apiKey,
          },
          ...acceptAllStatuses,
        },
      );
      expect(response.status).toBe(403);
    }, 20_000);

    test("Request drip returns 401 without API key", async () => {
      const response = await axios.post(
        `${faucetUrl}/v1/drips`,
        { recipientAddress: walletAddress, amount: requestedDripAmount },
        {
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
          },
          ...acceptAllStatuses,
        },
      );
      expect(response.status).toBe(401);
    }, 20_000);

    test("Request drip returns 400 for invalid address", async () => {
      const response = await axios.post(
        `${faucetUrl}/v1/drips`,
        { recipientAddress: "invalid_address", amount: requestedDripAmount },
        {
          headers: {
            ...thirdPartyHeaders,
            "Content-Type": "application/json",
          },
          ...acceptAllStatuses,
        },
      );
      expect(response.status).toBe(400);
    }, 20_000);

    test("Request drip returns 400 for invalid amount (zero)", async () => {
      const response = await axios.post<ErrorResponse>(
        `${faucetUrl}/v1/drips`,
        { recipientAddress: walletAddress, amount: "0" },
        {
          headers: {
            ...thirdPartyHeaders,
            "Content-Type": "application/json",
          },
          ...acceptAllStatuses,
        },
      );
      expect(response.status).toBe(400);
      expect(response.data.error).toContain("Invalid amount");
    }, 20_000);

    test("Request drip returns 400 for amount exceeding maximum", async () => {
      const response = await axios.post<ErrorResponse>(
        `${faucetUrl}/v1/drips`,
        { recipientAddress: walletAddress, amount: "999999" },
        {
          headers: {
            ...thirdPartyHeaders,
            "Content-Type": "application/json",
          },
          ...acceptAllStatuses,
        },
      );
      expect(response.status).toBe(400);
      expect(response.data.error).toContain("Invalid amount");
    }, 20_000);

    test("Request drip returns 400 for unsupported amount", async () => {
      const response = await axios.post<ErrorResponse>(
        `${faucetUrl}/v1/drips`,
        { recipientAddress: walletAddress, amount: "1001" },
        {
          headers: {
            ...thirdPartyHeaders,
            "Content-Type": "application/json",
          },
          ...acceptAllStatuses,
        },
      );
      expect(response.status).toBe(400);
      expect(response.data.error).toContain("Invalid amount");
    }, 20_000);

    test("Request drip returns 400 when using old 'address' field", async () => {
      const response = await axios.post(
        `${faucetUrl}/v1/drips`,
        { address: walletAddress, amount: "1000" },
        {
          headers: {
            ...thirdPartyHeaders,
            "Content-Type": "application/json",
          },
          ...acceptAllStatuses,
        },
      );
      expect(response.status).toBe(400);
    }, 20_000);

    test("Request drip returns 400 for non-integer amount (decimal)", async () => {
      const response = await axios.post(
        `${faucetUrl}/v1/drips`,
        { recipientAddress: walletAddress, amount: "10.5" },
        {
          headers: {
            ...thirdPartyHeaders,
            "Content-Type": "application/json",
          },
          ...acceptAllStatuses,
        },
      );
      expect(response.status).toBe(400);
    }, 20_000);

    test("Request drip returns 400 for numeric amount", async () => {
      const response = await axios.post(
        `${faucetUrl}/v1/drips`,
        { recipientAddress: walletAddress, amount: 1000 },
        {
          headers: {
            ...thirdPartyHeaders,
            "Content-Type": "application/json",
          },
          ...acceptAllStatuses,
        },
      );
      expect(response.status).toBe(400);
    }, 20_000);

    test("Request drip returns 400 for missing body fields", async () => {
      const response = await axios.post(
        `${faucetUrl}/v1/drips`,
        {},
        {
          headers: {
            ...thirdPartyHeaders,
            "Content-Type": "application/json",
          },
          ...acceptAllStatuses,
        },
      );
      expect(response.status).toBe(400);
    }, 20_000);
  });

  describe("GET /v1/drips/:dripId", () => {
    test("Poll drip status returns valid response", async () => {
      expect(dripId).toBeDefined();

      const response = await axios.get<DripResponse>(`${faucetUrl}/v1/drips/${dripId}`, {
        headers: thirdPartyHeaders,
      });

      expect(response.status).toBe(200);
      expect(response.data.dripId).toBe(dripId);
      expect(["PENDING", "CONFIRMED", "FAILED"]).toContain(response.data.status);
      console.log(`Drip status for ${dripId}:`, response.data);
    }, 20_000);

    test(
      "Poll drip until CONFIRMED or FAILED",
      async () => {
        expect(dripId).toBeDefined();
        console.log(`Polling drip status for dripId=${dripId}...`);

        const maxAttempts = 60;
        const pollInterval = 5000;
        let finalStatus: string | undefined;
        let confirmedTransactionHash: string | null | undefined;

        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((t) => setTimeout(t, pollInterval));
          const response = await axios.get<DripResponse>(`${faucetUrl}/v1/drips/${dripId}`, {
            headers: thirdPartyHeaders,
          });

          const status = response.data.status;
          console.log(`Attempt ${i + 1}: status=${status}`);

          if (status === "CONFIRMED") {
            finalStatus = status;
            confirmedTransactionHash = response.data.transactionHash;
            console.log(`Drip confirmed! transactionHash=${confirmedTransactionHash ?? ""}`);
            break;
          }

          if (status === "FAILED") {
            const detail = JSON.stringify(response.data);
            console.log(`Drip failed: ${detail}`);
            throw new Error(`Drip failed: ${detail}`);
          }
        }

        expect(finalStatus).toBe("CONFIRMED");
        expect(confirmedTransactionHash).toBeDefined();
        expect(typeof confirmedTransactionHash).toBe("string");
      },
      timeout,
    );

    test("Drip status returns 403 without Origin header", async () => {
      const response = await axios.get(`${faucetUrl}/v1/drips/${dripId}`, {
        headers: { "X-API-Key": apiKey },
        ...acceptAllStatuses,
      });
      expect(response.status).toBe(403);
    }, 20_000);

    test("Drip status returns 401 without API key", async () => {
      const response = await axios.get(`${faucetUrl}/v1/drips/${dripId}`, {
        headers: { Origin: origin },
        ...acceptAllStatuses,
      });
      expect(response.status).toBe(401);
    }, 20_000);
  });

  describe("Verify wallet balance", () => {
    test(
      "Verify that wallet balance was increased after drip",
      async () => {
        const expectedAmount = BigInt(requestedDripAmount) * 3_000_000n;
        const finalBalance = await utils.waitForBalanceIncrease(
          wallet,
          unshieldedTokenRaw,
          unshieldedBalanceInitial,
          expectedAmount,
        );
        expect(finalBalance).toBeGreaterThanOrEqual(unshieldedBalanceInitial + expectedAmount);
      },
      timeout,
    );
  });
});
