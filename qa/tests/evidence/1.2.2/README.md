# Midnight Faucet 1.2.2 — QA test evidence

## Overview

| Item                      | Value                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date                      | 2026-11-17 (runs 10:36–10:43 UTC)                                                                                                                             |
| QA contact                | Joe Tsang (@jtsang586)                                                                                                                                        |
| Release                   | [`v1.2.2`](https://github.com/midnightntwrk/midnight-faucet-api/releases/tag/v1.2.2), tag commit `bd3c0de319b5645b02973f03fc6da270aaacdeb2`                   |
| Faucet server (smoke)     | Published image `ghcr.io/midnightntwrk/midnight-faucet-api:v1.2.2@sha256:90da1e418c17d1dd7e7687b778d883d9d9ae546bddee39294a466347652f5f88`, not a local build |
| Faucet (unit/integration) | Workspace build of the tag commit `bd3c0de`. The server, core and auth packages are private, so they cannot be installed from npm                             |
| Published npm packages    | `@midnightntwrk/faucet-client@1.2.2` and `@midnightntwrk/faucet-internal-api@1.2.2`, both `gitHead` `bd3c0de`                                                 |
| Wallet SDK                | `@midnightntwrk/wallet-sdk` 2.0.1 (facade 5.0.1, shielded 4.0.1, unshielded-wallet 4.0.1, dust-wallet 5.1.0)                                                  |
| Ledger / ZKIR             | `@midnightntwrk/ledger-v9` 1.0.2, `@midnightntwrk/zkir-v2` 2.2.0                                                                                              |
| Node                      | `midnight-node:2.1.200-rc.2` (`sha256:ba37e5f7830e8a6187cbaa3093fd1b1755772685d055de5f2a5ccacfde818c68`)                                                      |
| Indexer                   | `indexer-standalone:4.4.101` (`sha256:119f35db548ba1c390845f215bb1e928e73038bef7c315825aee0461bd54499d`) — **not** the `4.1.101` the release pins; see below  |
| Proof server              | `proof-server:9.0.2-rc.1` (`sha256:c60185708418ef6bbea5ce6addae2376c5f84e9dbab5dca58ba69b5272b97359`)                                                         |
| Runtime                   | Node.js 26.13.0 (`.nvmrc`), Yarn 4.18.1, Docker 29.9.3, macOS arm64                                                                                           |
| QA sign-off               | ⚠️ All executed tests passed: 385 passed, 0 failed, 12 todo. Two release issues found, see [Release issues](#release-issues)                                  |

## Summary

| Environment                | Suite                                             |  Passed | Failed | Skipped / todo |   Total |
| -------------------------- | ------------------------------------------------- | ------: | -----: | -------------: | ------: |
| local (Testcontainers)     | `@midnightntwrk/faucet-server` unit + integration |     227 |      0 |             11 |     238 |
| local (Testcontainers)     | `@midnightntwrk/faucet` unit + integration        |     114 |      0 |              1 |     115 |
| local                      | `@midnightntwrk/faucet-auth` unit                 |      16 |      0 |              0 |      16 |
| undeployed (local network) | Smoke — faucet health and UI drip API             |       6 |      0 |              0 |       6 |
| undeployed (local network) | Smoke — third-party `/v1` API                     |      22 |      0 |              0 |      22 |
| **Total**                  |                                                   | **385** |  **0** |         **12** | **397** |

Every run exited 0. JUnit and console totals agree for every suite.

The server suite has 6 more tests than 1.2.1, all in `src/spec/config.spec.ts` ("third-party amounts"), added with the
start-up check for the third-party drip cap in PR #185. No test from 1.2.1 is missing.

### Failures

None.

### Skips and todos

All skips are static `it.todo` entries in the source, not runtime skips. They are the same 12 as in 1.2.1:

- `apps/server/src/spec/TaskManager.spec.ts`: 9 todo. The whole file is todo, so Vitest reports it as a skipped file (`17 passed | 1 skipped (18)`).
- `apps/server` state-persistence specs: 2 todo.
- `packages/faucet/src/spec/faucet.spec.ts`: 1 todo — "creates and submits transaction that sends tokens to provided address". The live dispense path is covered by the smoke suites below instead.

### What the smoke run exercised

- The published v1.2.2 image synced its wallet on a fresh ledger-v9 chain, reported healthy on `/api/health`, and dispensed tokens through the UI drip API (balance verified, request polled to completion). Transactions were proved by proof server 9.0.2-rc.1.
- On the third-party API, it served `/v1/health`, `/v1/drip-info`, `POST /v1/drips` and `GET /v1/drips/:dripId`, including API-key rejections (401) and validation errors (`INVALID_ADDRESS`, `INVALID_REQUEST`, `UNSUPPORTED_NETWORK`, `UNSUPPORTED_TOKEN`). A drip reached `CONFIRMED` with an on-chain transaction hash.

## Release issues

### 1. The released compose files pin an indexer image that does not exist

**Verified.** `tests/docker-compose-dynamic.yml` and the root `docker-compose.yml` at `v1.2.2` both pin
`ghcr.io/midnight-ntwrk/indexer-standalone:4.1.101`. That tag is not on ghcr (`docker manifest inspect` fails), so
neither stack can start as released. The release note's "Tested-with versions" table repeats `4.1.101`.

The change came in with PR #191 (the indexer moved from `4.4.0-rc.6` to `4.1.101`) and was already present in
`v1.2.2-alpha.3`. **Suspected:** it is a typo for `4.4.101`, the latest indexer release. The smoke run above used
`4.4.101`, swapped in locally. CI does not catch this because CI smoke runs only against hosted networks, which never
start this compose stack.

### 2. 1.2.2 will not start on any hosted faucet until gitops changes `THIRD_PARTY_MAX_AMOUNT`

**Verified.** 1.2.2 refuses to start when `THIRD_PARTY_MAX_AMOUNT` is below the default third-party drip (PR #185,
`apps/server/src/config.ts`). The `shieldedtech/shielded-gitops` overlays for devnet, qanet, preprod and preview all set
`THIRD_PARTY_MAX_AMOUNT: "1000"`, a whole-tNIGHT value from before the unit changed to the smallest denomination. They do
not set `THIRD_PARTY_DEFAULT_AMOUNT` or `DROP_AMOUNT`, so the default is `5000000000`. All four still run `v1.2.1`, as
checked on 2026-11-17.

The published v1.2.2 image, started with the smoke compose environment plus `THIRD_PARTY_MAX_AMOUNT=1000`, exits 1:

```text
Error: Expected 'thirdPartyApi.maxAmount' (1000) to be at least 'thirdPartyApi.defaultAmount' (5000000000). Both are in the token's smallest denomination — check THIRD_PARTY_MAX_AMOUNT and THIRD_PARTY_DEFAULT_AMOUNT; the cap is no longer whole tNIGHT.
```

The same image with `THIRD_PARTY_MAX_AMOUNT=5000000000` gets past config loading. This start-up failure is by design.
The gitops value has to be removed, or set to at least `5000000000`, before or together with the image bump.

## Relationship to 1.2.1

Faucet source changes since 1.2.1 are limited to that start-up check and its tests. Everything else is dependency and
image bumps: wallet SDK 2.0.0 → 2.0.1, ledger-v9 1.0.0 → 1.0.2, node `2.1.0-rc.4` → `2.1.200-rc.2`, and proof server
`9.0.0` → `9.0.2-rc.1`. The indexer pin changed as described above.

## Not covered

These were **not** run for 1.2.2 and are not claimed by the sign-off above:

- **Hosted environments (preprod, preview, qanet).** The scheduled hosted smoke/e2e workflows are still pinned to the ledger-v8 commit `f27b171`, and the hosted faucets run `v1.2.1`. See release issue 2.
- **The released indexer pin.** The released pin cannot be pulled, so no run used it.
- **Crossing the ledger v8 → v9 hard fork on a live network.** The local network starts on ledger v9. Fork-crossing logic is covered only by unit specs (`fork-crossing-schedule`, `ledger-v9-only-schedule`).
- **Playwright UI e2e** against `undeployed`.
- **Load test** (`tests/src/load`).
- **`packages/faucet` connectivity specs** use their own `test-compose.yml`, which pins older images (node `2.0.0-rc.3`, proof server `9.0.0-rc.7`, a pre-release indexer) rather than the stack in the table above.

## Test execution guide

Run outside the main clone, so its `.env` selects nothing. These runs used a `git archive v1.2.2` extract outside
`$HOME`, so no parent `.yarnrc.yml` was picked up. Secrets are shown as `...`.

```bash
mkdir run-1.2.2 && git archive v1.2.2 | tar -x -C run-1.2.2 && cd run-1.2.2
nvm use 26.13.0 && corepack enable
yarn install --immutable
yarn build

# Unit + integration (Docker must be running), one package at a time.
# Each package's JUnit lands in <package>/reports/report/test-report.xml.
export ENCRYPTION_KEY=... JWT_SIGN_SECRET=...
(cd packages/auth && yarn vitest run)
(cd packages/faucet && yarn pull-test-images && yarn vitest run)
(cd apps/server && yarn vitest run)
```

Smoke uses the published image and a working indexer, with two local, uncommitted changes to
`tests/docker-compose-dynamic.yml`:

- Replace the `faucet` service's `build:` block with
  `image: "ghcr.io/midnightntwrk/midnight-faucet-api:v1.2.2@sha256:90da1e418c17d1dd7e7687b778d883d9d9ae546bddee39294a466347652f5f88"`.
- Change `indexer-standalone:4.1.101` to `indexer-standalone:4.4.101`.

Then run one spec file at a time, with bail off so a failure in one cannot cancel the other. Both write
`tests/reports/report/test-report.xml`, so copy it after each run:

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

The health smoke JUnit is from a second run of `01_faucetHealthCheck` at 10:41–10:43 UTC. The first run (10:39–10:40,
also 6/6 passed) had its report overwritten by the third-party run.

## Raw results

JUnit XML, unedited except that absolute local paths were made repo-relative and the hostname was replaced with `local`:

- [`local/unit-integration-server/junit-test-results.xml`](local/unit-integration-server/junit-test-results.xml)
- [`local/unit-integration-faucet/junit-test-results.xml`](local/unit-integration-faucet/junit-test-results.xml)
- [`local/unit-integration-auth/junit-test-results.xml`](local/unit-integration-auth/junit-test-results.xml)
- [`undeployed/smoke-health/junit-test-results.xml`](undeployed/smoke-health/junit-test-results.xml)
- [`undeployed/smoke-third-party-api/junit-test-results.xml`](undeployed/smoke-third-party-api/junit-test-results.xml)
