import test, { expect } from "@playwright/test";
import { getConfig, getWalletConfig } from "../setup/envConfig";
import { pino } from "pino";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import * as utils from "../setup/utils";
import { DevnetFaucetMainPage } from "../pages/DevnetFaucetMainPage";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";

const logger = pino({
  transport: {
    target: "pino-pretty",
  },
});

const timeout = 60 * 60 * 1000; // 60 minutes

test.use({
  ignoreHTTPSErrors: true,
});

test.describe("Possible to request tokens from UI", () => {
  const config = getConfig();
  const walletConfig = getWalletConfig(config);
  let wallet: WalletFacade;
  const { seed } = config.wallet;
  const constants = utils.getConstants(config.networkId);
  const shieldedSecretKey = ledger.ZswapSecretKeys.fromSeed(utils.getShieldedSeed(seed));
  const dustSecretKey = ledger.DustSecretKey.fromSeed(utils.getDustSeed(seed));
  const unshieldedTokenRaw = ledger.unshieldedToken().raw;
  // const filenameWallet = `${seed.substring(0, 7)}-${process.env.NETWORK!}.state`;

  test.beforeAll(async () => {
    test.setTimeout(timeout);

    wallet = await utils.buildWalletFacade(seed, walletConfig);

    await wallet.start(shieldedSecretKey, dustSecretKey);
  });

  test("Request tokens from UI @PM-8163", async ({ page }) => {
    test.setTimeout(timeout);

    const FAUCET_URL = config.faucetUi;

    let balanceInitial: bigint;
    let balanceUpd: bigint;
    let WALLET_ADDRESS: string;

    // Faucet
    const faucet = await page.context().newPage();
    const faucetMainPage = utils.getFaucetEnvPage(config.networkId, faucet);

    await faucet.setExtraHTTPHeaders({
      "x-turnstile-token": process.env.TURNSTILE_HEADER ?? "",
    });

    await test.step("Restore and sync wallet", async () => {
      const synced = await utils.waitForUnshieldedSync(wallet);
      WALLET_ADDRESS = UnshieldedAddress.codec
        .encode(config.networkId, synced.unshielded.address)
        .asString();
      balanceInitial = synced.unshielded.balances[unshieldedTokenRaw] ?? 0n;
      logger.info(`Initial balance is ${balanceInitial}`);
    });

    await test.step("Request Tokens from Faucet UI", async () => {
      logger.info("Request Tokens from Faucet UI");
      await faucet.bringToFront();
      await faucet.goto(FAUCET_URL);

      await faucetMainPage.requestTokens(WALLET_ADDRESS);

      if (faucetMainPage instanceof DevnetFaucetMainPage) {
        await expect(faucetMainPage.notificationText).toContainText(constants.TEXT_TX_SUBMITTED, {
          timeout,
        });
      }
    });

    await test.step("Verify that balance was updated", async () => {
      logger.info("Verify that balance was updated");

      balanceUpd = await utils.waitForBalanceIncrease(
        wallet,
        unshieldedTokenRaw,
        balanceInitial,
        constants.DROP_AMOUNT,
      );
      expect(balanceUpd).toBeGreaterThanOrEqual(balanceInitial + constants.DROP_AMOUNT);

      logger.info("Balance was updated successfully");
      logger.info(`Updated balance is ${balanceUpd}`);
    });
  });
});
