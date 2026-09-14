# Faucet Client

A small package, allowing to use Faucet functionality in a programmatic way.
Its API is mostly a factory function to initialize the client, which can later
be used to request tokens from the faucet.

## Example

```ts
import { FaucetClient } from '@midnightntwrk/faucet-client';

const client = FaucetClient("http://localhost:5300/api");
const authToken = await client.login("<username>", "<password>");
const initialized = client.init(authToken);
const { transactionIdentifier } = initialized.requestTokens("<my wallet address>");
```
