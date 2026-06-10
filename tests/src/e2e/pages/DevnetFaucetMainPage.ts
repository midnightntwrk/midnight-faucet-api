import type { Locator, Page } from "@playwright/test";
import { FaucetMainPage } from "./FaucetMainPage";

export class DevnetFaucetMainPage extends FaucetMainPage {
  readonly addressInput: Locator;

  readonly requestTokensButton: Locator;

  constructor(readonly page: Page) {
    super(page);
    this.addressInput = page.locator("#address");
    this.requestTokensButton = page.locator('button[type="submit"]');
  }
}
