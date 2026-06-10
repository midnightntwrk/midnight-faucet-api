import { ClientError } from "@midnight-ntwrk/faucet-client";
import { DripResponse, FaucetClientRequests } from "@midnight-ntwrk/faucet-internal-api";
import { RequestTokensForm } from "./requestTokensForm.js";
import { useSubmit } from "./submit.js";
import { useHealthStatus } from "./useHealthStatus.js";

const DROP_AMOUNT_TNIGHT = "1000";

export function AppContainer(props: { client: FaucetClientRequests }) {
  const isHealthy = useHealthStatus(props.client.healthStatus$);
  const tokenRequestSubmit = useSubmit<{ address: string; captchaToken: string }, DripResponse>(
    async (request) =>
      props.client
        .requestTokens(request.address, request.captchaToken, DROP_AMOUNT_TNIGHT)
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

  return <RequestTokensForm submit={tokenRequestSubmit} isHealthy={isHealthy} />;
}
