# Midnight Faucet

A production-grade token faucet for the Midnight Network, built with TypeScript and RxJS. Provides both public (captcha-protected) and third-party (API-key authenticated) endpoints for requesting test tokens.

**Features:**
- Multi-wallet support (shielded, unshielded, dust) with automatic syncing
- Task-queue based transaction processing with PostgreSQL persistence
- Prometheus metrics and health checks
- Captcha-protected public API (Cloudflare Turnstile)
- API-key authenticated third-party integration endpoints
- Full state serialization/recovery for fault tolerance

## Quick Start

### Local Development (Full Stack)

The fastest way to get running locally:

```shell
docker-compose up
```

This brings up:
- PostgreSQL database
- Midnight node
- Indexer service
- Proof server
- Faucet server

### Manual Setup

1. **Install dependencies:**
   ```shell
   yarn install
   ```

2. **Build all packages:**
   ```shell
   yarn build
   ```

3. **Configure the faucet:**
   ```shell
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Run migrations:**
   ```shell
   npx midnight-faucet migrate-db
   ```

5. **Start the server:**
   ```shell
   npx midnight-faucet start
   ```

View available commands: `npx midnight-faucet help`

### Frontend Development Only

To develop just the UI without the full stack:

```shell
cd apps/ui
yarn && yarn start
```

## Project Structure

This is a **Turborepo monorepo** with the following structure:

### Apps
- **`apps/server`** — Express HTTP server, wallet management, task queue orchestration
- **`apps/ui`** — React + Vite web interface

### Packages
- **`packages/faucet`** — Core faucet implementation (wallet integration, transaction handling)
- **`packages/auth`** — JWT and password authentication primitives
- **`packages/faucet-client`** — TypeScript client library for the public API
- **`packages/faucet-internal-api`** — Shared API types and codecs (io-ts)
- **`packages/faucet-utils`** — Lifecycle utilities (Resource/Task patterns)

### Tests
- **`tests/`** — Smoke tests and E2E tests (Vitest + Playwright)

## API Documentation

### Public API (`/api/*`)

Requires Cloudflare Turnstile captcha verification.

#### `POST /api/drips`

Request a token drip.

```bash
curl -X POST http://localhost:3000/api/drips \
  -H "Content-Type: application/json" \
  -H "X-Captcha-Token: <turnstile_token>" \
  -d '{
    "recipientAddress": "mn_addr_...",
    "amount": "1000"
  }'
```

**Response (200 OK):**
```json
{
  "dripId": "string",
  "status": "PENDING",
  "taskStatus": "scheduled",
  "transactionHash": null,
  "error": null
}
```

#### `GET /api/drips/:dripId`

Poll for drip status.

```bash
curl http://localhost:3000/api/drips/abc123-def456 \
  -H "X-Captcha-Token: <turnstile_token>"
```

#### `GET /api/health`

Check service health.

#### `GET /api/ready`

Readiness probe for Kubernetes/load balancers.

#### `GET /api/metrics`

Prometheus metrics (text or JSON).

### Third-Party API (`/v1/*`)

For whitelisted partner integrations (origin whitelist + API key authentication).

See **[Third-Party API Documentation](./THIRD_PARTY_API.md)** for complete details, including:
- `POST /v1/drips` — Request a drip
- `GET /v1/drips/{dripId}` — Get status
- `GET /v1/health` — Check health

## Configuration

Configuration is loaded via:
1. `convict` config file (JSON5 format, path via `FAUCET_CONFIG_FILE`)
2. Environment variables
3. CLI arguments

For all available options:
```shell
npx midnight-faucet help
```

Key env vars:
- `FAUCET_CONFIG_FILE` — Path to JSON5 config file
- `WALLET_SEED` — 32-byte hex wallet seed
- `DATABASE_URL` — PostgreSQL connection string
- `NODE_URL` — Midnight node RPC endpoint
- `INDEXER_URL` — Indexer service URL
- `PROOF_SERVER_URL` — Proof server URL

See `apps/server/src/config.ts` for the authoritative schema.

## Development

### Commands

```bash
# From repo root (Turbo orchestrates across workspaces)
yarn build              # Build all packages
yarn typecheck          # Type-check all packages
yarn lint               # Lint with ESLint (--max-warnings=0)
yarn test               # Run all tests (Vitest)
yarn check              # build + lint + test
yarn format             # Format with Prettier

# Inside a specific workspace (e.g., packages/faucet)
cd packages/faucet
yarn build              # tsc -b ./tsconfig.build.json
yarn test               # vitest run
yarn lint
```

### Running Single Tests

```bash
# From a workspace directory
yarn test path/to/spec.spec.ts                    # One file
yarn test -t "test name"                          # By test name
yarn test --reporter=verbose path/to/spec.spec.ts # Verbose output
```

### Architecture Notes

**Read CLAUDE.md** for in-depth architecture details, including:
- Composition root and dependency injection
- Task queue and transaction pipeline
- State persistence and recovery
- RxJS patterns and wallet SDK integration
- Health checks and observability

Key architectural decisions:
- **ESM throughout** with `--experimental-specifier-resolution=node`
- **Resource/Task lifecycle** from `@midnight-ntwrk/faucet-utils` (not raw Promises)
- **io-ts codecs** for API types (source of truth)
- **RxJS for streams** (wallet state, health checks, metrics)
- **Postgres task queue** for durable transaction execution

## Docker

### Build and Run

```bash
# Build the Docker image
docker build -t midnight-faucet .

# Run with custom node URL
docker run \
  --net=host \
  -e NODE_URL='http://localhost:9944' \
  -e DATABASE_URL='postgresql://user:pass@localhost/faucet' \
  midnight-faucet
```

### Using Published Images

```bash
docker pull ghcr.io/midnightntwrk/midnight-faucet:main
docker run --net=host \
  -e NODE_URL='http://node:9944' \
  ghcr.io/midnightntwrk/midnight-faucet:main
```

See [docker-compose.yml](./docker-compose.yml) for a complete example.

## Security

For security issues and vulnerability disclosure, see [SECURITY.md](./SECURITY.md).

**Key security features:**
- Transaction validation (coins verified before signing)
- Concurrent transaction prevention (coin freshness checks)
- State encryption and persistence recovery
- Health monitoring and automatic recovery on sync stalls

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on:
- Setting up your development environment
- Code style and conventions
- Testing requirements
- Submitting pull requests
- Commit message format

## Release and Version Management

We use Git Flow for releases:

1. **Bump version** on `develop`:
   ```bash
   yarn workspaces foreach version <major|minor|patch|pre> --immediate
   ```

2. **Create release branch:**
   ```bash
   git checkout -b release/v0.13.0
   ```

3. **Create GitHub release** with release notes

4. **Tag creation** triggers CD to build and publish:
   - Docker images to `ghcr.io/midnightntwrk/midnight-faucet`
   - NPM packages to GitHub Packages
   - Release artifacts

5. **After deploy**, merge release branch into `main`

See [Git Flow](https://nvie.com/posts/a-successful-git-branching-model/) for details.

## License

MIT License - see [LICENSE](./LICENSE) file for details.

## Support

- **Bug reports**: [GitHub Issues](https://github.com/midnightntwrk/midnight-faucet/issues)
- **Security issues**: See [SECURITY.md](./SECURITY.md)
- **Questions**: GitHub Discussions or Midnight Discord

## Useful References

- [Midnight Protocol](https://midnight.network/)
- [Wallet SDK Documentation](https://docs.midnight.network/develop/sdk)
- [Turborepo Docs](https://turbo.build/repo/docs)
- [RxJS Documentation](https://rxjs.dev/)
