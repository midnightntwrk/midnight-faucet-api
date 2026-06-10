import type { Locator, Page } from "@playwright/test";

export class FaucetMainPage {
  readonly page: Page;

  readonly addressInput: Locator;

  readonly notificationText: Locator;

  readonly requestTokensButton: Locator;

  youtubeIcon: Locator;

  xIcon: Locator;

  inIcon: Locator;

  constructor(page: Page) {
    this.page = page;
    this.addressInput = page.locator("#address");
    this.notificationText = page.locator("form p");
    this.requestTokensButton = page.locator('button[type="submit"]');
    this.youtubeIcon = page.locator('[aria-label="Youtube"]');
    this.xIcon = page.locator('[aria-label="Twitter/X"]');
    this.inIcon = page.locator("ul li:nth-child(3) a");
  }

  async requestTokens(address: string): Promise<void> {
    await this.addressInput.fill(address);
    await this.requestTokensButton.click();
  }

  async acceptCookies(): Promise<void> {
    await this.page.getByRole("button", { name: "Accept" }).click();
  }
}
