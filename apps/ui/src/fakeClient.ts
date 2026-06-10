import {
  DripResponse,
  FaucetClientRequests,
  HealthStatus,
  WalletAddress,
} from "@midnight-ntwrk/faucet-internal-api";
import { of } from "rxjs";

const randomDelay = () =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.random() * 5000);
  });

const healthyStatus: HealthStatus = { status: "ok" };

export const fakeClient = new (class FakeFaucetClient implements FaucetClientRequests {
  healthStatus$ = of(healthyStatus);

  requestTokens(
    _address: WalletAddress,
    _captchaToken: string,
    _amount: string,
  ): Promise<DripResponse> {
    return randomDelay().then(() => {
      return {
        dripId: crypto.randomUUID(),
        status: "CONFIRMED" as const,
        taskStatus: "success",
        transactionHash: crypto.randomUUID(),
        error: null,
      };
    });
  }
})();
