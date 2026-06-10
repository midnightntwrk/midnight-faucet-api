/* eslint-disable @typescript-eslint/no-floating-promises */
import test, { expect } from "@playwright/test";
import { getConfig } from "../setup/envConfig";
import { getConstants, getFaucetEnvPage } from "../setup/utils";
import { pino } from "pino";

const logger = pino({
  transport: {
    target: "pino-pretty",
  },
});

test.describe("UI Verifications.", () => {
  test("Basic UI checks @PM-8163", async ({ page }) => {
    const envConfig = getConfig();
    const constants = getConstants(envConfig.networkId);

    const FAUCET_URL = envConfig.faucetUi;
    const WALLET_ADDRESS = envConfig.wallet.address;
    const faucet = await page.context().newPage();
    const faucetMainPage = getFaucetEnvPage(envConfig.networkId, faucet);
    faucet.setExtraHTTPHeaders({
      "x-turnstile-token": process.env.TURNSTILE_HEADER ?? "",
    });

    await faucet.goto(FAUCET_URL);

    await test.step("Request Tokens button is disabled by default", async () => {
      logger.info("Request tokens button is disabled by default");
      await expect(faucetMainPage.requestTokensButton).toBeDisabled();
    });

    await test.step("Request Tokens button is enabled only when Wallet Address is filled with captcha passed", async () => {
      logger.info("Request Tokens button is enabled only when Wallet Address is filled");
      await faucetMainPage.addressInput.fill(WALLET_ADDRESS);
      await expect(faucetMainPage.requestTokensButton).toBeEnabled({ timeout: 20_000 });
    });

    await test.step("Impossible to request funds for an invalid wallet address", async () => {
      logger.info("Impossible to request funds for an invalid wallet address");
      await faucet.reload();

      await expect(faucetMainPage.requestTokensButton).toHaveText(constants.BUTTON_LABEL_INITIAL);
      await expect(faucetMainPage.notificationText).not.toBeVisible();

      await faucetMainPage.requestTokens("test");
      await expect(faucet.getByText(constants.BUTTON_LABEL_REQUEST)).toBeVisible();
      await expect(faucet.getByText(constants.ERROR_INVALID_ADDRESS)).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("Social networks icons contain valid links", async () => {
      logger.info("Social networks icons contain valid links");
      const youtubeLink = await faucetMainPage.youtubeIcon.getAttribute("href");
      const xLink = await faucetMainPage.xIcon.getAttribute("href");
      const inLink = await faucetMainPage.inIcon.getAttribute("href");

      expect(youtubeLink).toBe(constants.LINK_YOUTUBE);
      expect(xLink).toBe(constants.LINK_X);
      expect(inLink).toBe(constants.LINK_IN);
    });
  });
});
