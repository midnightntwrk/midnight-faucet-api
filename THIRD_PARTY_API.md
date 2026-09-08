# Third-Party Drip API

The Midnight Faucet's `/v1` API, for partner integrations. It follows the Drip API specification, so a partner that
already speaks that specification needs no faucet-specific code. Captcha verification does not apply to this surface —
the API key is the credential.

## Base URLs

The faucet is deployed per network; the deployment you call determines the network you get.

| Network | Base URL                                  | Description                                      |
| ------- | ----------------------------------------- | ------------------------------------------------ |
| Preview | `https://faucet.preview.midnight.network` | For early testing and development                |
| Preprod | `https://faucet.preprod.midnight.network` | For pre-production testing before mainnet launch |

All paths below are appended to the base URL (e.g. `https://faucet.preview.midnight.network/v1/drips`).

## Authentication

Every request carries a pre-shared API key in the `X-API-Key` header:

```
X-API-Key: your-api-key
```

A missing, malformed or unrecognised key is answered with `401 Unauthorized` and the error code `INVALID_API_KEY`.

Calls are server-to-server, so no `Origin` header is expected or required. A deployment serving a browser-side partner
can additionally switch on an origin allow-list (`THIRD_PARTY_REQUIRE_ORIGIN`), in which case requests must carry an
`Origin` matching a pre-registered domain; a rejected origin answers `403 Forbidden` with `VERIFICATION_REJECTED`.

## Amounts

Amounts are integer **strings in the token's smallest denomination** — `"5000000000"`, not `"1000"` and not a number.
Strings avoid the floating-point precision loss a large denomination would otherwise hit.

`amount` is optional. Omitted (or `null`), the faucet dispenses its configured default, which
[`GET /v1/drip-info`](#get-v1drip-infonetworktoken) reports.

## Error responses

Every error, on every endpoint, has the same body:

```json
{
  "error": {
    "code": "string",
    "message": "string | null"
  }
}
```

`message` is human-readable context for support escalations and is not meant for end users.

| Error Code              | HTTP Status               | Trigger                                                                  |
| ----------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `INVALID_ADDRESS`       | 400 Bad Request           | The recipient address failed Bech32m/network validation.                 |
| `UNSUPPORTED_NETWORK`   | 400 Bad Request           | The requested network is not the one this deployment serves.             |
| `UNSUPPORTED_TOKEN`     | 400 Bad Request           | The requested token is not the one this deployment serves.               |
| `INVALID_REQUEST`       | 400 Bad Request           | Malformed body, or an amount that is not an integer string within range. |
| `INVALID_API_KEY`       | 401 Unauthorized          | The `X-API-Key` header is missing or does not match.                     |
| `VERIFICATION_REJECTED` | 403 Forbidden             | The origin allow-list is enforced and rejected the request.              |
| `RATE_LIMIT_EXCEEDED`   | 429 Too Many Requests     | The address has no drip left for today.                                  |
| `INSUFFICIENT_FUNDS`    | 503 Service Unavailable   | The faucet wallet is drained and cannot fulfil the drip.                 |
| `SERVICE_UNAVAILABLE`   | 503 Service Unavailable   | The node is desynced, or a temporary internal outage is in progress.     |
| `INTERNAL_ERROR`        | 500 Internal Server Error | An unhandled faucet-side failure.                                        |

`INVALID_REQUEST` is an extension: the specification defines no literal for a malformed body or a bad amount. Callers
that only know the canonical literals treat it as `INTERNAL_ERROR`, which is the intended fallback for anything
unrecognised.

Rate limiting is **per address, per day** (default: 25 requests).

## Endpoints

### POST /v1/drips

Start a drip. The operation is asynchronous — a 200 means the drip was accepted and queued, and
[`GET /v1/drips/{dripId}`](#get-v1dripsdripid) reports how it ends. Requests that cannot be served are rejected here,
synchronously.

**Headers:** `Content-Type: application/json`, `X-API-Key`

**Body:**

```json
{
  "recipientAddress": "string",
  "network": "string",
  "token": "string",
  "amount": "string",
  "fulfillmentContext": {}
}
```

| Field                | Type           | Required | Description                                                                        |
| -------------------- | -------------- | -------- | ---------------------------------------------------------------------------------- |
| `recipientAddress`   | string         | Yes      | Recipient wallet address (Bech32m, e.g. `mn_addr_...`)                             |
| `network`            | string         | Yes      | Network identifier, e.g. `midnight_preview`. Matched case-insensitively.           |
| `token`              | string         | Yes      | Token identifier, e.g. `tNIGHT`. Matched case-insensitively.                       |
| `amount`             | string \| null | No       | Amount in the smallest denomination. Omitted, the configured default is dispensed. |
| `fulfillmentContext` | object \| null | No       | Opaque JSON passed through from the caller's frontend, for authorization purposes. |

**Success (200 OK):**

```json
{
  "dripId": "string"
}
```

A retry that arrives while an earlier drip for the same address is still in flight answers 200 with that drip's
`dripId` — the call is idempotent for as long as the drip is unresolved, and no second drip is dispensed.

**Example:**

```bash
curl -X POST https://faucet.preview.midnight.network/v1/drips \
  -H "Content-Type: application/json" \
  -H "Origin: https://your-whitelisted-domain.com" \
  -H "X-API-Key: $YOUR_API_KEY" \
  -d '{
    "recipientAddress": "mn_addr_undeployed17cnw4q78cjvyyu8mtkynd0pjtk9qjhhschwakjwwml4xflxcw0mswvqz9g",
    "network": "midnight_preview",
    "token": "tNIGHT",
    "amount": "5000000000"
  }'
```

---

### GET /v1/drips/{dripId}

Poll a drip. **Always answers 200**, including for an unknown or malformed `dripId` — a failure is reported in the body,
not as an HTTP status, so a poller can read it the same way every time.

**Headers:** `X-API-Key`

**Response (200 OK):**

```json
{
  "dripId": "string",
  "status": "PENDING | CONFIRMED | FAILED",
  "transactionHash": "string | null",
  "error": { "code": "string", "message": "string | null" }
}
```

| Field             | Type           | Description                                                |
| ----------------- | -------------- | ---------------------------------------------------------- |
| `dripId`          | string         | The identifier this drip was created with                  |
| `status`          | string         | `PENDING` (queued or dispensing), `CONFIRMED`, or `FAILED` |
| `transactionHash` | string \| null | Transaction identifier; present once `CONFIRMED`           |
| `error`           | object \| null | Present only when `FAILED`                                 |

An unknown `dripId` answers `FAILED` with `INVALID_REQUEST`; a drip that failed answers `FAILED` with `INTERNAL_ERROR`.

**Example:**

```bash
curl https://faucet.preview.midnight.network/v1/drips/6f1f1c34-6f2e-4c4a-9a3f-3a1f2b6c9d10 \
  -H "X-API-Key: your-api-key"
```

---

### GET /v1/drip-info/{network}/{token}

The amount a drip dispenses when the request omits `amount`. Poll it to keep a displayed amount current instead of
hardcoding one.

**Headers:** `X-API-Key`

**Path parameters:** `network` (e.g. `midnight_preview`), `token` (e.g. `tNIGHT`)

**Response (200 OK):**

```json
{
  "dripAmount": "string"
}
```

`dripAmount` is in the token's smallest denomination. A network or token this deployment does not serve answers 400
with `UNSUPPORTED_NETWORK` / `UNSUPPORTED_TOKEN`.

**Example:**

```bash
curl https://faucet.preview.midnight.network/v1/drips/abc123-task-id \
  -H "Origin: https://your-whitelisted-domain.com" \
  -H "X-API-Key: $YOUR_API_KEY"

```

---

### GET /v1/health

Whether the faucet can serve drips. **Always answers 200** — the state is in the body, so a monitor reads one shape
whatever the answer.

**Headers:** `X-API-Key`

**Response (200 OK):**

```json
{
  "status": "SERVING | NOT_SERVING",
  "reason": "string | null"
}
```

| Reason               | Meaning                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `NODE_DESYNCED`      | The wallet is behind, recovering, or upstream services are unreachable       |
| `WALLET_BALANCE_LOW` | The faucet wallet cannot fund further drips                                  |
| `INTERNAL_ERROR`     | An internal failure — state could not be persisted, or a check itself failed |

`reason` is `null` while `SERVING`. Finer-grained internal reasons are reported on the operator-facing `/api/health`.

**Example:**

```bash
curl https://faucet.preview.midnight.network/v1/health \
  -H "Origin: https://your-whitelisted-domain.com" \
  -H "X-API-Key: $YOUR_API_KEY"
```

---

## Integration flow

1. **Check health** — `GET /v1/health`, and proceed while `status` is `SERVING`.
2. **Read the drip amount** (optional) — `GET /v1/drip-info/{network}/{token}`, if you display it.
3. **Request the drip** — `POST /v1/drips`, and keep the `dripId`.
4. **Poll** — `GET /v1/drips/{dripId}` until `CONFIRMED` or `FAILED`. Polling every few seconds is plenty; drips
   settle in well under a minute in normal operation.

### JavaScript

```javascript
const FAUCET_URL = "https://faucet.preview.midnight.network";
const API_KEY = process.env.FAUCET_API_KEY;

const headers = { "X-API-Key": API_KEY, "Content-Type": "application/json" };

const requestDrip = async (recipientAddress) => {
  const response = await fetch(`${FAUCET_URL}/v1/drips`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      recipientAddress,
      network: "midnight_preview",
      token: "tNIGHT",
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${body.error.code}: ${body.error.message ?? ""}`);
  }
  return body.dripId;
};

const waitForDrip = async (dripId) => {
  for (;;) {
    const response = await fetch(`${FAUCET_URL}/v1/drips/${dripId}`, { headers });
    const drip = await response.json();

    if (drip.status === "CONFIRMED") return drip.transactionHash;
    if (drip.status === "FAILED")
      throw new Error(`${drip.error.code}: ${drip.error.message ?? ""}`);

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
};
```

### Python

```python
import os
import time
import requests

FAUCET_URL = "https://faucet.preview.midnight.network"
HEADERS = {"X-API-Key": os.environ["FAUCET_API_KEY"], "Content-Type": "application/json"}


def request_drip(recipient_address: str) -> str:
    response = requests.post(
        f"{FAUCET_URL}/v1/drips",
        headers=HEADERS,
        json={
            "recipientAddress": recipient_address,
            "network": "midnight_preview",
            "token": "tNIGHT",
        },
    )
    body = response.json()
    if not response.ok:
        raise RuntimeError(f"{body['error']['code']}: {body['error'].get('message')}")
    return body["dripId"]


def wait_for_drip(drip_id: str) -> str:
    while True:
        drip = requests.get(f"{FAUCET_URL}/v1/drips/{drip_id}", headers=HEADERS).json()

        if drip["status"] == "CONFIRMED":
            return drip["transactionHash"]
        if drip["status"] == "FAILED":
            raise RuntimeError(f"{drip['error']['code']}: {drip['error'].get('message')}")

        time.sleep(5)
```

## Configuration (operators)

| Variable                      | Default              | Purpose                                                             |
| ----------------------------- | -------------------- | ------------------------------------------------------------------- |
| `THIRD_PARTY_API_KEY`         | _(empty)_            | The pre-shared key. Empty disables the API entirely.                |
| `THIRD_PARTY_NETWORK`         | `midnight_<network>` | The `network` literal accepted by this deployment.                  |
| `THIRD_PARTY_TOKEN`           | `tNIGHT`             | The `token` literal accepted by this deployment.                    |
| `THIRD_PARTY_DEFAULT_AMOUNT`  | `DROP_AMOUNT`        | Dispensed when a request omits `amount`, smallest denomination.     |
| `THIRD_PARTY_MAX_AMOUNT`      | `DROP_AMOUNT`        | Largest accepted `amount`, smallest denomination.                   |
| `THIRD_PARTY_REQUIRE_ORIGIN`  | `false`              | Enforce the origin allow-list (browser-side partners only).         |
| `THIRD_PARTY_ALLOWED_ORIGINS` | _(empty)_            | Comma-separated origins, used only when the allow-list is enforced. |
