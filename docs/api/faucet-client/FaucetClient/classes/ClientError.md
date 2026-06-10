**[@midnight-ntwrk/faucet-client v0.6.1](https://github.com/input-output-hk/midnight-faucet)** • [Readme](../../README.md) \| [API](../../modules.md)

***

[@midnight-ntwrk/faucet-client v0.6.1](../../README.md) / [FaucetClient](../README.md) / ClientError

# Class: ClientError

FaucetClient-specific subclass of `Error`

## Extends

- `Error`

## Constructors

### new ClientError(type, message)

> **new ClientError**(`type`, `message`): [`ClientError`](ClientError.md)

#### Parameters

• **type**: `"error"` \| `"decoding_error"` \| `"auth_error"` \| `"rate_limit_error"`

• **message**: `string`

#### Returns

[`ClientError`](ClientError.md)

#### Overrides

`Error.constructor`

## Properties

### type

> **`readonly`** **type**: `"error"` \| `"decoding_error"` \| `"auth_error"` \| `"rate_limit_error"`

Error type. Following values are expected:

- "decoding_error" -- to indicate decoding of request or response payload failed (is generally not expected when using the client)
- "error" -- to indicate general/unexpected error that occurred when processing a request
- "auth_error" -- to indicate authentication error
- "rate_limit_error" -- to indicate exceeding rate limit set in place
