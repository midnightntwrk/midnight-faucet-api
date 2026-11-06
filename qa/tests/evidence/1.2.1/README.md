# Midnight Faucet 1.2.1 — QA test evidence

## Overview

| Item                      | Value                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date                      | 2026-11-06 (runs 10:32–10:37 UTC)                                                                                                                             |
| QA contact                | Joe Tsang (@jtsang586)                                                                                                                                        |
| Release                   | [`v1.2.1`](https://github.com/midnightntwrk/midnight-faucet-api/releases/tag/v1.2.1), tag commit `8c3359400b1d0bbde8b310723edf3edae6d617ac`                   |
| Faucet server (smoke)     | Published image `ghcr.io/midnightntwrk/midnight-faucet-api:v1.2.1@sha256:9f2d6fd88561546b08d8ea5ef73d87350c89d14499a22afe3d4c3f086cdec574`, not a local build |
| Faucet (unit/integration) | Workspace build of the tag commit `8c33594`. The server, core and auth packages are private, so they cannot be installed from npm                             |
| Published npm packages    | `@midnightntwrk/faucet-client@1.2.1` and `@midnightntwrk/faucet-internal-api@1.2.1`, both `gitHead` `8c33594`                                                 |
| Wallet SDK                | `@midnightntwrk/wallet-sdk` 2.0.0 (facade 5.0.0, shielded 4.0.0, unshielded-wallet 4.0.0, dust-wallet 5.0.0)                                                  |
| Ledger / ZKIR             | `@midnightntwrk/ledger-v9` 1.0.0, `@midnightntwrk/zkir-v2` 2.2.0                                                                                              |
| Node                      | `midnight-node:2.1.0-rc.4`                                                                                                                                    |
| Indexer                   | `indexer-standalone:4.4.0-rc.6`                                                                                                                               |
| Proof server              | `proof-server:9.0.0` (`sha256:5617e26aa76d06c44f4bee667c37eb71ccf02fefe0e5848100fa84001282d515`)                                                              |
| Runtime                   | Node.js 26.12.0 (`.nvmrc`), Yarn 4.18.1, Docker 29.9.2, macOS arm64                                                                                           |
| QA sign-off               | ✅ All executed tests passed: 367 passed, 0 failed, 12 todo. See [Not covered](#not-covered) for the scope this does **not** include                          |

## Summary

| Environment                | Suite                                             |  Passed | Failed | Skipped / todo |   Total |
| -------------------------- | ------------------------------------------------- | ------: | -----: | -------------: | ------: |
| local (Testcontainers)     | `@midnightntwrk/faucet-server` unit + integration |     221 |      0 |             11 |     232 |
| local (Testcontainers)     | `@midnightntwrk/faucet` unit + integration        |     114 |      0 |              1 |     115 |
| local                      | `@midnightntwrk/faucet-auth` unit                 |      16 |      0 |              0 |      16 |
| undeployed (local network) | Smoke — faucet health and UI drip API             |       6 |      0 |              0 |       6 |
| undeployed (local network) | Smoke — third-party `/v1` API                     |      22 |      0 |              0 |      22 |
| **Total**                  |                                                   | **367** |  **0** |         **12** | **379** |

Every run exited 0. JUnit and console totals agree for every suite.

### Failures

None.

### Skips and todos

All skips are static `it.todo` entries in the source, not runtime skips:

- `apps/server/src/spec/TaskManager.spec.ts`: 9 todo. The whole file is todo, so Vitest reports it as a skipped file (`17 passed | 1 skipped (18)`).
- `apps/server` state-persistence specs: 2 todo.
- `packages/faucet/src/spec/faucet.spec.ts`: 1 todo — "creates and submits transaction that sends tokens to provided address". The live dispense path is covered by the smoke suites below instead.

### What the smoke run exercised

- The published v1.2.1 image synced its wallet on a fresh ledger-v9 chain, reported healthy on `/api/health`, and dispensed tokens through the UI drip API (balance verified, request polled to completion). Transactions were proved by proof server 9.0.0.
- On the third-party API, it served `/v1/health`, `/v1/drip-info`, `POST /v1/drips` and `GET /v1/drips/:dripId`, including API-key rejections (401) and validation errors (`INVALID_ADDRESS`, `INVALID_REQUEST`, `UNSUPPORTED_NETWORK`, `UNSUPPORTED_TOKEN`). A drip reached `CONFIRMED` with an on-chain transaction hash.

## Relationship to 1.2.0

1.2.1 is 1.2.0 plus the proof-server bump from `9.0.0-rc.8` to `9.0.0` (compose files only) and a version bump. The faucet source is unchanged.

The `v1.2.0` tag was moved to `375585aa` after its first release, but its artifacts were not rebuilt. CD failed on `You cannot publish over the previously published versions: 1.2.0`, so npm 1.2.0 and `ghcr.io/midnightntwrk/midnight-faucet-api:v1.2.0` remain the earlier `6a799ee` build, tested against proof server `9.0.0-rc.8`. Deploy 1.2.1.

## Not covered

These were **not** run for 1.2.1 and are not claimed by the sign-off above:

- **Hosted environments (preprod, preview, qanet).** The scheduled hosted smoke/e2e workflows are pinned to the ledger-v8 commit `f27b171`, so their results say nothing about 1.2.1.
- **Crossing the ledger v8 → v9 hard fork on a live network.** The local network starts on ledger v9. Fork-crossing logic is covered only by unit specs (`fork-crossing-schedule`, `ledger-v9-only-schedule`).
- **Playwright UI e2e.** `tests/src/e2e` has no `undeployed` target.
- **Load test** (`tests/src/load`).
- **`packages/faucet` connectivity specs** use their own `test-compose.yml`, which pins older images (node `2.0.0-rc.3`, proof server `9.0.0-rc.7`, a pre-release indexer) rather than the stack in the table above.

## Test execution guide

Run from a worktree at the tag, so the main clone's `.env` does not select anything. Secrets are shown as `...`.

```bash
git worktree add .claude/worktrees/release-1.2.1-evidence v1.2.1
cd .claude/worktrees/release-1.2.1-evidence
nvm use 26.12.0 && corepack enable
yarn install --immutable
yarn build

# Unit + integration (Docker must be running)
ENCRYPTION_KEY=... JWT_SIGN_SECRET=... \
  yarn turbo run test --continue --concurrency=1
```

Smoke, against the published image: in `tests/docker-compose-dynamic.yml`, replace the `faucet` service's `build:` block with
`image: "ghcr.io/midnightntwrk/midnight-faucet-api:v1.2.1@sha256:9f2d6fd88561546b08d8ea5ef73d87350c89d14499a22afe3d4c3f086cdec574"`
(local, uncommitted change). Then run one spec file at a time with bail off, so a failure in one cannot cancel the other:

```bash
cd tests
export NETWORK=undeployed THIRD_PARTY_API_KEY=test TESTCONTAINERS_UID=501 \
  ENCRYPTION_KEY=... JWT_SIGN_SECRET=... \
  INDEXER_STORAGE_PASSWORD=... INDEXER_PUB_SUB_PASSWORD=... \
  INDEXER_LEDGER_STATE_PASSWORD=... INDEXER_SECRET=...
yarn vitest run src/smoke/01_faucetHealthCheck.spec.ts --bail=0
yarn vitest run src/smoke/02_thirdPartyDrip.spec.ts --bail=0
```

`THIRD_PARTY_API_KEY` must be `test`, to match the key the compose file gives the faucet.

## Raw results

JUnit XML, unedited except that absolute local paths were made repo-relative and the hostname was replaced with `local`:

- [`local/unit-integration-server/junit-test-results.xml`](local/unit-integration-server/junit-test-results.xml)
- [`local/unit-integration-faucet/junit-test-results.xml`](local/unit-integration-faucet/junit-test-results.xml)
- [`local/unit-integration-auth/junit-test-results.xml`](local/unit-integration-auth/junit-test-results.xml)
- [`undeployed/smoke-health/junit-test-results.xml`](undeployed/smoke-health/junit-test-results.xml)
- [`undeployed/smoke-third-party-api/junit-test-results.xml`](undeployed/smoke-third-party-api/junit-test-results.xml)
