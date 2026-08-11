# Third-Party Drip API

This document describes the Third-Party API for requesting tDUST tokens from the Midnight Faucet. This API is designed for whitelisted partner integrations and does not require captcha verification.

## Base URLs

The Midnight Faucet is deployed on two networks. Use the appropriate URL based on which network your application is targeting:

| Network | Base URL                                  | Description                                      |
| ------- | ----------------------------------------- | ------------------------------------------------ |
| Preview | `https://faucet.preview.midnight.network` | For early testing and development                |
| Preprod | `https://faucet.preprod.midnight.network` | For pre-production testing before mainnet launch |

> **Note:** The network is determined by the faucet URL you connect to. There is no network parameter in the API requests. All API paths are appended to the base URL (e.g., `https://faucet.preview.midnight.network/v1/drips`).

## Authentication

Authentication requires both **Origin URL whitelisting** and an **API key**.

### Origin Header
Your application's origin must be pre-registered with the faucet administrator. All requests must include an `Origin` header matching your whitelisted domain:

```
Origin: https://your-whitelisted-domain.com
```

Requests from non-whitelisted origins will receive a `403 Forbidden` response.

### API Key
All requests must include the `X-API-Key` header with your assigned API key:

```
X-API-Key: your-api-key
```

| Status | Description |
|--------|-------------|
| `401 Unauthorized` | API key is missing |
| `403 Forbidden` | API key is invalid |

## Rate Limiting

- **Per-address daily limit**: Each wallet address is limited to a maximum number of requests per day (default: 25).
- Rate limits reset at midnight UTC.

## Endpoints

### POST /v1/drips

Request a token drip to a wallet address.

#### Request

**Headers:**
| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | Must be `application/json` |
| `Origin` | Yes | Your whitelisted origin URL |
| `X-API-Key` | Yes | Your assigned API key |

**Body:**

```json
{
  "recipientAddress": "string",
  "amount": "string"
}
```

| Field              | Type   | Required | Description                                                                            |
| ------------------ | ------ | -------- | -------------------------------------------------------------------------------------- |
| `recipientAddress` | string | Yes      | Recipient wallet address (Bech32m format, e.g., `mn_addr_...`)                         |
| `amount`           | string | Yes      | Amount of tDUST to send (non-negative integer as string). Must be between 1 and the configured maximum (default: 1000). String type prevents floating-point precision loss with large denominations. |

#### Response

**Success (200 OK):**

```json
{
  "dripId": "string",
  "status": "PENDING",
  "transactionHash": null,
  "error": null
}
```

**Errors:**

| Status                  | Description                                                     |
| ----------------------- | --------------------------------------------------------------- |
| `400 Bad Request`       | Invalid request body, invalid address format, or invalid amount |
| `403 Forbidden`         | Origin not whitelisted                                          |
| `429 Too Many Requests` | Rate limit exceeded for this address                            |

**Error Response:**

```json
{
  "error": "string"
}
```

#### Example

```bash
curl -X POST https://faucet.preview.midnight.network/v1/drips \
  -H "Content-Type: application/json" \
  -H "Origin: https://your-whitelisted-domain.com" \
  -H "X-API-Key: $YOUR_API_KEY" \
  -d '{
    "recipientAddress": "mn_addr_undeployed17cnw4q78cjvyyu8mtkynd0pjtk9qjhhschwakjwwml4xflxcw0mswvqz9g",
    "amount": "1000"
  }'
```

---

### GET /v1/drips/{dripId}

Get the status of a drip request.

#### Request

**Headers:**
| Header | Required | Description |
|--------|----------|-------------|
| `Origin` | Yes | Your whitelisted origin URL |
| `X-API-Key` | Yes | Your assigned API key |

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `dripId` | string | The drip ID returned from `POST /v1/drips` |

#### Response

**Success (200 OK):**

```json
{
  "dripId": "string",
  "status": "PENDING" | "CONFIRMED" | "FAILED",
  "transactionHash": "string | null",
  "error": "string | null"
}
```

| Field             | Type           | Description                                            |
| ----------------- | -------------- | ------------------------------------------------------ |
| `dripId`          | string         | The unique identifier for this drip request            |
| `status`          | string         | Current status: `PENDING`, `CONFIRMED`, or `FAILED`    |
| `transactionHash` | string \| null | Transaction identifier (only present when `CONFIRMED`) |
| `error`           | string \| null | Error message (only present when `FAILED`)             |

**Status Values:**
| Status | Description |
|--------|-------------|
| `PENDING` | Request is queued or being processed |
| `CONFIRMED` | Transaction completed successfully |
| `FAILED` | Transaction failed |

#### Example

```bash
curl https://faucet.preview.midnight.network/v1/drips/abc123-task-id \
  -H "Origin: https://your-whitelisted-domain.com" \
  -H "X-API-Key: $YOUR_API_KEY"
```

---

### GET /v1/health

Check if the faucet service is ready to process drip requests.

#### Request

**Headers:**
| Header | Required | Description |
|--------|----------|-------------|
| `Origin` | Yes | Your whitelisted origin URL |
| `X-API-Key` | Yes | Your assigned API key |

#### Response

**Success (200 OK):**

```json
{
  "status": "SERVING" | "NOT_SERVING",
  "reason": "string | null"
}
```

| Field    | Type           | Description                                      |
| -------- | -------------- | ------------------------------------------------ |
| `status` | string         | `SERVING` if ready, `NOT_SERVING` if unavailable |
| `reason` | string \| null | Reason for `NOT_SERVING` status                  |

**Possible Reasons for NOT_SERVING:**
| Reason | Description |
|--------|-------------|
| `SERVICES_DOWN` | External services (indexer, proof-server) are unreachable |
| `SYNC_STUCK_RECOVERY` | Wallet sync is stuck and recovery is in progress |
| `STATE_PERSISTENCE_FAILURE` | Failed to persist wallet state |
| `SYNC_BEHIND` | Wallet is not fully synced with the network |
| `WALLET_BALANCE_LOW` | Faucet wallet has insufficient funds |
| `INTERNAL_ERROR` | Internal service error |

#### Example

```bash
curl https://faucet.preview.midnight.network/v1/health \
  -H "Origin: https://your-whitelisted-domain.com" \
  -H "X-API-Key: $YOUR_API_KEY"
```

---

## Integration Flow

1. **Check health** before sending drip requests:

   ```
   GET /v1/health
   ```

   Ensure `status` is `SERVING`.

2. **Request a drip**:

   ```
   POST /v1/drips
   ```

   Store the returned `dripId`.

3. **Poll for completion**:
   ```
   GET /v1/drips/{dripId}
   ```
   Poll until `status` changes from `PENDING` to `CONFIRMED` or `FAILED`.

### Recommended Polling Strategy

- Initial delay: 5 seconds after POST
- Poll interval: 5-10 seconds
- Maximum attempts: 60 (5 minutes total)
- Consider exponential backoff for production use

---

## Code Examples

### JavaScript/TypeScript

```typescript
const FAUCET_URL = "https://faucet.preview.midnight.network";

async function requestDrip(recipientAddress: string, amount: string): Promise<string> {
  const response = await fetch(`${FAUCET_URL}/v1/drips`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://your-whitelisted-domain.com",
      "X-API-Key": "your-api-key",
    },
    body: JSON.stringify({ recipientAddress, amount }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to request drip");
  }

  const data = await response.json();
  return data.dripId;
}

async function waitForDrip(dripId: string): Promise<{ status: string; transactionHash?: string }> {
  const maxAttempts = 60;
  const pollInterval = 5000;

  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(`${FAUCET_URL}/v1/drips/${dripId}`, {
      headers: {
        Origin: "https://your-whitelisted-domain.com",
        "X-API-Key": "your-api-key",
      },
    });

    const data = await response.json();

    if (data.status === "CONFIRMED") {
      return { status: "CONFIRMED", transactionHash: data.transactionHash };
    }

    if (data.status === "FAILED") {
      throw new Error(data.error || "Drip failed");
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error("Timeout waiting for drip confirmation");
}

// Usage
const dripId = await requestDrip("mn_addr_...", "1000");
const result = await waitForDrip(dripId);
console.log("Transaction hash:", result.transactionHash);
```

### Python

```python
import requests
import time

FAUCET_URL = 'https://faucet.preview.midnight.network'
HEADERS = {
    'Content-Type': 'application/json',
    'Origin': 'https://your-whitelisted-domain.com',
    'X-API-Key': 'your-api-key',
}

def request_drip(address: str, amount: str) -> str:
    response = requests.post(
        f'{FAUCET_URL}/v1/drips',
        json={'recipientAddress': address, 'amount': amount},
        headers=HEADERS,
    )
    response.raise_for_status()
    return response.json()['dripId']

def wait_for_drip(drip_id: str, max_attempts: int = 60, poll_interval: int = 5) -> dict:
    for _ in range(max_attempts):
        response = requests.get(
            f'{FAUCET_URL}/v1/drips/{drip_id}',
            headers=HEADERS,
        )
        data = response.json()

        if data['status'] == 'CONFIRMED':
            return {'status': 'CONFIRMED', 'transactionHash': data['transactionHash']}

        if data['status'] == 'FAILED':
            raise Exception(data.get('error', 'Drip failed'))

        time.sleep(poll_interval)

    raise Exception('Timeout waiting for drip confirmation')

# Usage
drip_id = request_drip('mn_addr_...', '1000')
result = wait_for_drip(drip_id)
print(f"Transaction hash: {result['transactionHash']}")
```

---

## Onboarding

To get your application whitelisted for the Third-Party API:

1. Contact the Midnight team with your application details
2. Provide the origin URL(s) that will be making requests
3. Once approved, you will receive:
   - Your origin added to the whitelist
   - Your API key for authentication

---

## Support

For questions or issues with the Third-Party API, please contact the Midnight support team.
