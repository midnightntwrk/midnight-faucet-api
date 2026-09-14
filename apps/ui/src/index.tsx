import { FaucetClient } from "@midnightntwrk/faucet-client";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { fakeClient } from "./fakeClient.js";

declare const API_URL: string;
declare const USE_FAKE_API: boolean;

const theClient = USE_FAKE_API
  ? fakeClient
  : FaucetClient({
      url: API_URL,
      pollInterval: 10000,
    });

const target = document.createElement("div");
target.className = "app";
document.body.appendChild(target);
createRoot(target).render(<App client={theClient} />);
