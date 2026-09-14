**[@midnightntwrk/faucet-client v0.6.1](https://github.com/input-output-hk/midnight-faucet)** • [Readme](../../README.md) \| [API](../../modules.md)

***

[@midnightntwrk/faucet-client v0.6.1](../../README.md) / [FaucetClient](../README.md) / FaucetClient

# Function: FaucetClient()

> **FaucetClient**(`url`, `pollInterval`, `fetchFn`): `FaucetRequests`

Client's entrypoint. It takes  and (optionally) fetch function to use.

## Parameters

• **url**: `string`

API url, like `http://localhost:5300/api` in local development

• **pollInterval**: `number`= `10_000`

how often check request status

• **fetchFn**= `fetch`

fetch function to use. By default it is `global.fetch`, but in case of additional
  configurations needed it is possible to override it with any compatible function

## Returns

`FaucetRequests`
