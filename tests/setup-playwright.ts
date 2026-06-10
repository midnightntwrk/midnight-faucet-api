import { webcrypto } from "node:crypto";
import { type FullConfig } from "@playwright/test";

async function globalSetup(_config: FullConfig) {
  Object.defineProperty(global, "crypto", {
    value: webcrypto,
  });
}

export default globalSetup;
