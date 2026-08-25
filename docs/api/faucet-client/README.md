**[@midnight-ntwrk/faucet-client v0.6.1](https://github.com/midnightntwrk/midnight-faucet-api)** • Readme \| [API](modules.md)

***

# Faucet Client

A small package, allowing to use Faucet functionality in a programmatic way.
Its API is mostly a factory function to initialize the client, which can later
be used to request tokens from the faucet.

## Example

```ts
import { FaucetClient } from "@midnight-ntwrk/faucet-client";

const client = FaucetClient({ url: "http://localhost:5300/api" });
const drip = await client.requestTokens("<my wallet address>", "<captcha-token>", "1000");
console.log(drip.transactionHash);
```
