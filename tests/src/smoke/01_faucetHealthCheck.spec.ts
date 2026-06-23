import axios from "axios";
import * as utils from "../e2e/setup/utils";
import { TestContainersFixture, useTestContainersFixture } from "./test-fixture";
import { WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import * as ledger from "@midnightntwrk/ledger-v9";
import { describe, expect, beforeAll, afterAll, test } from "vitest";
import { randomBytes } from "node:crypto";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";

interface ReadinessResponse {
  status: string;
  details: Record<string, string>;
}

interface HealthResponse {
  status: string;
  reason: string | null;
}

interface DripResponse {
  dripId: string;
  status: string;
  transactionHash: string | null;
}

describe("Faucet Smoke Tests", () => {
  const getFixture = useTestContainersFixture();
  const seed = randomBytes(32).toString("hex");
  const shieldedSecretKey = ledger.ZswapSecretKeys.fromSeed(utils.getShieldedSeed(seed));
  const dustSecretKey = ledger.DustSecretKey.fromSeed(utils.getDustSeed(seed));
  const shieldedTokenRaw = ledger.shieldedToken().raw;
  const unshieldedTokenRaw = ledger.unshieldedToken().raw;
  // const filenameWallet = `${seed.substring(0, 7)}-${TestContainersFixture.network}.state`;
  const timeout = 60 * 60 * 1000; // 60 minutes

  let wallet: WalletFacade;
  let shieldedBalanceInitial: bigint;
  let unshieldedBalanceInitial: bigint;
  let balanceUpd: bigint;
  let faucetUrl: string;
  let dripId: string;
  let networkId: NetworkId.NetworkId;

  beforeAll(async () => {
    const fixture = getFixture();
    const walletConfig = fixture.getWalletConfig();
    networkId = walletConfig.networkId;
    faucetUrl = fixture.getFaucetUrl();
    wallet = await utils.buildWalletFacade(seed, walletConfig);
    await wallet.start(shieldedSecretKey, dustSecretKey);
  }, timeout);

  afterAll(async () => {
    await wallet.stop();
  }, timeout);

  test("Faucet Readiness Check", async () => {
    const maxRetries = 10;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.get<ReadinessResponse>(`${faucetUrl}/api/ready`, {
          timeout: 5000,
        });
        expect(response.statusText).toBe("OK");
        expect(response.status).toBe(200);

        expect(response.data.details["faucet-sync"]).toBe("ok");
        console.log("Readiness status:", response.data.status, response.data.details);
        return;
      } catch (error) {
        lastError = error;
        console.log(`Readiness check attempt ${attempt}/${maxRetries} failed, retrying in 5s...`);
        if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 5000));
      }
    }
    throw lastError;
  }, 60_000);

  test("Faucet Health Check", async () => {
    const maxRetries = 10;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.get<HealthResponse>(`${faucetUrl}/api/health`, {
          timeout: 5000,
        });

        expect(response.statusText).toBe("OK");
        expect(response.status).toBe(200);

        expect(response.data.status).toBe("SERVING");
        console.log("Health status:", response.data.status, response.data.reason);
        return;
      } catch (error) {
        lastError = error;
        console.log(`Health check attempt ${attempt}/${maxRetries} failed, retrying in 5s...`);
        if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 5000));
      }
    }
    throw lastError;
  }, 60_000);

  test(
    "Verify initial wallet balance",
    async () => {
      const state = await utils.waitForUnshieldedSync(wallet);
      shieldedBalanceInitial = state?.shielded.balances[shieldedTokenRaw];
      console.log(`Initial shielded token balance =${shieldedBalanceInitial}`);
      unshieldedBalanceInitial = state.unshielded.balances[unshieldedTokenRaw] ?? 0n;
      console.log(`Initial unshielded token balance =${unshieldedBalanceInitial}`);
      expect(state).toBeDefined();
    },
    timeout,
  );

  test(
    "Request tokens from Faucet",
    async () => {
      const state = await utils.waitForUnshieldedSync(wallet);
      const address = utils.getUnshieldedAddress(networkId, state.unshielded.address);
      const response = await axios.post<DripResponse>(
        `${faucetUrl}/api/drips`,
        {
          recipientAddress: address,
          amount: "1000",
        },
        {
          headers: {
            "X-Captcha-Token": "XXXX.DUMMY.TOKEN.XXXX",
            "x-turnstile-token": process.env.TURNSTILE_HEADER ?? "",
          },
        },
      );
      expect(response.statusText).toBe("OK");
      expect(response.status).toBe(200);

      dripId = response.data.dripId;
      expect(response.data.status).toBe("PENDING");
      console.log(`dripId=${dripId}`);
    },
    timeout,
  );
  test(
    "Verify Polling request",
    async () => {
      let finalStatus: string | undefined;
      // Waiting for 'CONFIRMED' polling status
      for (let i = 0; i < 25; i++) {
        await new Promise((t) => setTimeout(t, 5000));
        const response = await axios.get<DripResponse>(`${faucetUrl}/api/drips/${dripId}`);
        console.log(response.data);
        const dripStatus = response.data.status;

        if (dripStatus === "CONFIRMED") {
          finalStatus = dripStatus;
          const txId = response.data.transactionHash;
          console.log(`txId=${txId}`);
          break;
        }
        if (dripStatus === "FAILED") {
          console.log(response.data);
          throw new Error(`Polling failed: ${JSON.stringify(response.data)}`);
        }
      }
      expect(finalStatus).toBe("CONFIRMED");
    },
    timeout,
  );

  test(
    "Verify that wallet balance was increased",
    async () => {
      balanceUpd = await utils.waitForBalanceIncrease(
        wallet,
        unshieldedTokenRaw,
        unshieldedBalanceInitial,
        TestContainersFixture.DROP_AMOUNT,
      );
      expect(balanceUpd).toBeGreaterThanOrEqual(
        unshieldedBalanceInitial + TestContainersFixture.DROP_AMOUNT,
      );
    },
    timeout,
  );
});
