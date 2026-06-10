import { FaucetClientRequests } from "@midnight-ntwrk/faucet-internal-api";
import { AppContainer } from "./appContainer.js";
import { AppLayout } from "./appLayout.js";

export const App = (props: { client: FaucetClientRequests }) => {
  return (
    <AppLayout>
      <AppContainer client={props.client} />
    </AppLayout>
  );
};
