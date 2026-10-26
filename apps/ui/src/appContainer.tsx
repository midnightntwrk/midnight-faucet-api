import { ClientError } from "@midnight-ntwrk/faucet-client";
import { DripResponse, FaucetClientRequests } from "@midnight-ntwrk/faucet-internal-api";
import { RequestTokensForm } from "./requestTokensForm.js";
import { useSubmit } from "./submit.js";
import { useHealthStatus } from "./useHealthStatus.js";
import { runtimeConfig } from "./runtimeConfig.js";

/**
 * Used only if the server served a page without injecting its own drip, which
 * would mean `runtimeConfigMiddleware` did not run. Matches the `dropAmount`
 * default in the server's config.ts.
 */
const FALLBACK_DROP_AMOUNT_TNIGHT = "5000";

export function AppContainer(props: { client: FaucetClientRequests }) {
  const isHealthy = useHealthStatus(props.client.healthStatus$);
  const dropAmountTNight = runtimeConfig().dropAmountTNight ?? FALLBACK_DROP_AMOUNT_TNIGHT;
  const tokenRequestSubmit = useSubmit<{ address: string; captchaToken: string }, DripResponse>(
    async (request) =>
      props.client
        .requestTokens(request.address, request.captchaToken, dropAmountTNight)
        .catch((error) => {
          if (error instanceof ClientError) {
            switch (error.type) {
              case "rate_limit_error":
              case "auth_error":
              case "error":
                return Promise.reject(error);
              case "decoding_error":
                return Promise.reject(new Error("Received incorrect data"));
            }
          } else {
            return Promise.reject(new Error("An error occurred when processing request"));
          }
        }),
  );

  return (
    <RequestTokensForm
      submit={tokenRequestSubmit}
      isHealthy={isHealthy}
      dropAmountTNight={dropAmountTNight}
    />
  );
}
