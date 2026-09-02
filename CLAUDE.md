# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Overview

The Midnight Faucet dispenses tNight tokens to a requester's address, rate-limited per address per day. It is a
Turborepo / Yarn-workspaces monorepo:

| Workspace                        | Role                                                                       |
| -------------------------------- | -------------------------------------------------------------------------- |
| `apps/server`                    | HTTP API, the `TaskManager` dispense queue, rate limiting, Postgres (knex)  |
| `apps/ui`                        | Frontend                                                                    |
| `packages/faucet`                | Core faucet logic (`FaucetImpl.ts`)                                         |
| `packages/faucet-internal-api`   | io-ts codecs / shared API types (the source of truth for request/response) |
| `packages/faucet-client`         | Client for the public API                                                  |
| `packages/faucet-auth`           | Auth                                                                        |
| `packages/faucet-utils`          | `Resource` / `Task` / `pipe` primitives used across the server             |

The key files to read first are listed in the coding conventions imported below (under **Key files**).

## Coding conventions

The project's coding conventions are the single source of truth for how to write code here — read and follow them:

@docs/CodingConventions.md

## Commands

Run from the repo root (Turbo fans out to the workspaces):

```bash
yarn build       # build all packages
yarn typecheck   # tsc across the workspaces
yarn lint        # eslint (must pass with --max-warnings=0)
yarn test        # vitest
yarn format      # prettier
yarn check       # build + lint + test
```

Notes:

- **Server tests use Testcontainers** — a Postgres container is started per run, so Docker must be running.
- Server config requires `JWT_SIGN_SECRET` (a hex string), loaded from `.env` via direnv in local dev. Without it,
  `loadConfig()` fails and the server-integration suite is skipped.

## More

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — workflow, branch naming, commit format, PR process.
- [`docs/CodingConventions.md`](docs/CodingConventions.md) — the conventions imported above.
