# Faucet Tests

## Running tests against a deployed network

### 1. Set up environment variables

Set the `NETWORK` environment variable to the target deployment:

```shell
export NETWORK=qanet    # or preview, preprod
```

### 2. Run tests

From `tests` directory run:

```shell
yarn smoke-test
```

## Running tests locally (undeployed)

Running tests with `NETWORK=undeployed` uses [testcontainers](https://node.testcontainers.org/) to spin up a full local Midnight stack (node, indexer, proof-server, faucet, and database) via Docker Compose.

### 1. Install dependencies

From the repository root:

```shell
yarn install
```

### 2. Set up environment variables

The `tests/.env` file comes pre-configured with default values including `NETWORK=undeployed`. No additional setup is needed unless you want to override defaults.

### 3. Run tests

From the `tests` directory:

```shell
# Smoke tests (API-level tests via vitest)
yarn smoke-test

# E2E tests (browser tests via Playwright)
yarn e2e-test
```

> **Note:** The first run may take several minutes as Docker images are pulled and containers start up (up to 5 minutes for all services to become healthy).
