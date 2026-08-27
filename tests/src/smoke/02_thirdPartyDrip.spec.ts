import axios from "axios";
import * as utils from "../e2e/setup/utils";
import { useTestContainersFixture } from "./test-fixture";
import { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import * as ledger from "@midnightntwrk/ledger-v9";
import { describe, expect, beforeAll, afterAll, test } from "vitest";
import { randomBytes } from "node:crypto";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";

interface HealthResponse {
  status: string;
  reason: string | null;
}

interface CreateDripResponse {
  dripId: string;
}

interface DripStatusResponse {
  dripId: string;
  status: string;
  transactionHash: string | null;
  error: { code: string; message: string | null } | null;
}

interface ErrorResponse {
  error: { code: string; message: string | null };
}

interface DripInfoResponse {
  dripAmount: string;
}

describe("Third-Party API Smoke Tests", () => {
  const getFixture = useTestContainersFixture();
  const seed = randomBytes(32).toString("hex");
  const shieldedSecretKey = ledger.ZswapSecretKeys.fromSeed(utils.getShieldedSeed(seed));
  const dustSecretKey = ledger.DustSecretKey.fromSeed(utils.getDustSeed(seed));
  const unshieldedTokenRaw = ledger.unshieldedToken().raw;
  // The third-party API denominates amounts in the token's smallest unit, and
  // this is the deployment's default drip (DROP_AMOUNT) expressed in it.
  const requestedDripAmount = "5000000000";
  const timeout = 60 * 60 * 1000; // 60 minutes

  let wallet: WalletFacade;
  let faucetUrl: string;
  let networkId: NetworkId.NetworkId;
  let walletAddress: string;
  let dripId: string;
  let unshieldedBalanceInitial: bigint;
  let network: string;

  const token = "tNIGHT";
  const apiKey = process.env.THIRD_PARTY_API_KEY ?? "";

  if (!apiKey) {
    throw new Error(
      "THIRD_PARTY_API_KEY environment variable is required but was empty or not set",
    );
  }

  // The API key is the credential; Google calls server-to-server and sends no
  // Origin header, so the requests here don't either.
  const thirdPartyHeaders = {
    "X-API-Key": apiKey,
  };

  const jsonHeaders = {
    ...thirdPartyHeaders,
    "Content-Type": "application/json",
  };

  const acceptAllStatuses = { validateStatus: () => true };

  const dripBody = (overrides: Record<string, unknown> = {}) => ({
    recipientAddress: walletAddress,
    network,
    token,
    amount: requestedDripAmount,
    ...overrides,
  });

  beforeAll(async () => {
    const fixture = getFixture();
    const walletConfig = fixture.getWalletConfig();
    networkId = walletConfig.networkId;
    network = `midnight_${String(networkId).toLowerCase()}`;
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

    test("Health check returns 401 without API key", async () => {
      const response = await axios.get<ErrorResponse>(`${faucetUrl}/v1/health`, {
        ...acceptAllStatuses,
      });
      expect(response.status).toBe(401);
      expect(response.data.error.code).toBe("INVALID_API_KEY");
    }, 20_000);

    test("Health check returns 401 with invalid API key", async () => {
      const response = await axios.get<ErrorResponse>(`${faucetUrl}/v1/health`, {
        headers: { "X-API-Key": "invalid-api-key" },
        ...acceptAllStatuses,
      });
      expect(response.status).toBe(401);
      expect(response.data.error.code).toBe("INVALID_API_KEY");
    }, 20_000);
  });

  describe("GET /v1/drip-info/:network/:token", () => {
    test("Drip info reports the configured amount", async () => {
      const response = await axios.get<DripInfoResponse>(
        `${faucetUrl}/v1/drip-info/${network}/${token}`,
        { headers: thirdPartyHeaders },
      );

      expect(response.status).toBe(200);
      expect(response.data.dripAmount).toMatch(/^[0-9]+$/);
      console.log("Drip info:", response.data);
    }, 20_000);

    test("Drip info returns UNSUPPORTED_NETWORK for another network", async () => {
      const response = await axios.get<ErrorResponse>(
        `${faucetUrl}/v1/drip-info/ethereum_testnet/${token}`,
        { headers: thirdPartyHeaders, ...acceptAllStatuses },
      );

      expect(response.status).toBe(400);
      expect(response.data.error.code).toBe("UNSUPPORTED_NETWORK");
    }, 20_000);

    test("Drip info returns UNSUPPORTED_TOKEN for another token", async () => {
      const response = await axios.get<ErrorResponse>(`${faucetUrl}/v1/drip-info/${network}/ETH`, {
        headers: thirdPartyHeaders,
        ...acceptAllStatuses,
      });

      expect(response.status).toBe(400);
      expect(response.data.error.code).toBe("UNSUPPORTED_TOKEN");
    }, 20_000);
  });

  describe("POST /v1/drips", () => {
    test(
      "Request drip returns the dripId alone",
      async () => {
        const response = await axios.post<CreateDripResponse>(`${faucetUrl}/v1/drips`, dripBody(), {
          headers: jsonHeaders,
        });

        expect(response.status).toBe(200);
        expect(typeof response.data.dripId).toBe("string");
        expect(Object.keys(response.data)).toEqual(["dripId"]);

        dripId = response.data.dripId;
        console.log(`Drip requested successfully, dripId=${dripId}`);
      },
      timeout,
    );

    test("Request drip returns 401 without API key", async () => {
      const response = await axios.post<ErrorResponse>(`${faucetUrl}/v1/drips`, dripBody(), {
        headers: { "Content-Type": "application/json" },
        ...acceptAllStatuses,
      });
      expect(response.status).toBe(401);
      expect(response.data.error.code).toBe("INVALID_API_KEY");
    }, 20_000);

    test("Request drip returns INVALID_ADDRESS for an invalid address", async () => {
      const response = await axios.post<ErrorResponse>(
        `${faucetUrl}/v1/drips`,
        dripBody({ recipientAddress: "invalid_address" }),
        { headers: jsonHeaders, ...acceptAllStatuses },
      );
      expect(response.status).toBe(400);
      expect(response.data.error.code).toBe("INVALID_ADDRESS");
    }, 20_000);

    test("Request drip returns UNSUPPORTED_NETWORK for another network", async () => {
      const response = await axios.post<ErrorResponse>(
        `${faucetUrl}/v1/drips`,
        dripBody({ network: "ethereum_testnet" }),
        { headers: jsonHeaders, ...acceptAllStatuses },
      );
      expect(response.status).toBe(400);
      expect(response.data.error.code).toBe("UNSUPPORTED_NETWORK");
    }, 20_000);

    test("Request drip returns UNSUPPORTED_TOKEN for another token", async () => {
      const response = await axios.post<ErrorResponse>(
        `${faucetUrl}/v1/drips`,
        dripBody({ token: "ETH" }),
        { headers: jsonHeaders, ...acceptAllStatuses },
      );
      expect(response.status).toBe(400);
      expect(response.data.error.code).toBe("UNSUPPORTED_TOKEN");
    }, 20_000);

    test("Request drip returns INVALID_REQUEST for a zero amount", async () => {
      const response = await axios.post<ErrorResponse>(
        `${faucetUrl}/v1/drips`,
        dripBody({ amount: "0" }),
        { headers: jsonHeaders, ...acceptAllStatuses },
      );
      expect(response.status).toBe(400);
      expect(response.data.error.code).toBe("INVALID_REQUEST");
      expect(response.data.error.message).toContain("Invalid amount");
    }, 20_000);

    test("Request drip returns INVALID_REQUEST for an amount above the maximum", async () => {
      // THIRD_PARTY_MAX_AMOUNT defaults to DROP_AMOUNT, so one unit past the
      // deployment's own drip is the smallest value that must be rejected.
      const overMax = (BigInt(requestedDripAmount) + 1n).toString();
      const response = await axios.post<ErrorResponse>(
        `${faucetUrl}/v1/drips`,
        dripBody({ amount: overMax }),
        { headers: jsonHeaders, ...acceptAllStatuses },
      );
      expect(response.status).toBe(400);
      expect(response.data.error.code).toBe("INVALID_REQUEST");
      expect(response.data.error.message).toContain("Invalid amount");
    }, 20_000);

    test("Request drip returns INVALID_REQUEST for a decimal amount", async () => {
      const response = await axios.post<ErrorResponse>(
        `${faucetUrl}/v1/drips`,
        dripBody({ amount: "10.5" }),
        { headers: jsonHeaders, ...acceptAllStatuses },
      );
      expect(response.status).toBe(400);
      expect(response.data.error.code).toBe("INVALID_REQUEST");
    }, 20_000);

    test("Request drip returns INVALID_REQUEST for a numeric amount", async () => {
      const response = await axios.post<ErrorResponse>(
        `${faucetUrl}/v1/drips`,
        dripBody({ amount: 1000 }),
        { headers: jsonHeaders, ...acceptAllStatuses },
      );
      expect(response.status).toBe(400);
      expect(response.data.error.code).toBe("INVALID_REQUEST");
    }, 20_000);

    test("Request drip returns INVALID_REQUEST when using the old 'address' field", async () => {
      const response = await axios.post<ErrorResponse>(
        `${faucetUrl}/v1/drips`,
        { address: walletAddress, network, token, amount: requestedDripAmount },
        { headers: jsonHeaders, ...acceptAllStatuses },
      );
      expect(response.status).toBe(400);
      expect(response.data.error.code).toBe("INVALID_REQUEST");
    }, 20_000);

    test("Request drip returns INVALID_REQUEST for missing body fields", async () => {
      const response = await axios.post<ErrorResponse>(
        `${faucetUrl}/v1/drips`,
        {},
        { headers: jsonHeaders, ...acceptAllStatuses },
      );
      expect(response.status).toBe(400);
      expect(response.data.error.code).toBe("INVALID_REQUEST");
    }, 20_000);
  });

  describe("GET /v1/drips/:dripId", () => {
    test("Poll drip status returns valid response", async () => {
      expect(dripId).toBeDefined();

      const response = await axios.get<DripStatusResponse>(`${faucetUrl}/v1/drips/${dripId}`, {
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
          const response = await axios.get<DripStatusResponse>(`${faucetUrl}/v1/drips/${dripId}`, {
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

    // The spec has the caller poll this endpoint, so it answers 200 with the
    // failure in the body rather than an HTTP error.
    test("Unknown dripId answers 200 with an error object", async () => {
      const response = await axios.get<DripStatusResponse>(
        `${faucetUrl}/v1/drips/00000000-0000-0000-0000-000000000000`,
        { headers: thirdPartyHeaders, ...acceptAllStatuses },
      );

      expect(response.status).toBe(200);
      expect(response.data.status).toBe("FAILED");
      expect(response.data.error?.code).toBe("INVALID_REQUEST");
    }, 20_000);

    test("Drip status returns 401 without API key", async () => {
      const response = await axios.get<ErrorResponse>(`${faucetUrl}/v1/drips/${dripId}`, {
        ...acceptAllStatuses,
      });
      expect(response.status).toBe(401);
      expect(response.data.error.code).toBe("INVALID_API_KEY");
    }, 20_000);
  });

  describe("Verify wallet balance", () => {
    test(
      "Verify that wallet balance was increased after drip",
      async () => {
        // A lower bound: the dispensed amount is split across outputs, and
        // integer division can shave a unit off the total.
        const expectedAmount = (BigInt(requestedDripAmount) * 3n) / 5n;
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
