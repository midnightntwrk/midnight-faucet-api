# Contributing to Midnight Faucet

Thank you for your interest in contributing! This document provides guidelines and instructions for getting started.

## Code of Conduct

We are committed to providing a welcoming and inclusive environment. Please be respectful and constructive in all interactions.

## Getting Started

### Prerequisites

- **Node.js**: 24.11.1+ (check `.nvmrc`)
- **Yarn**: 4.13.0+ (Berry with node-modules linker)
- **Docker & Docker Compose**: For local development with full stack
- **Git**: For version control

### Setup Development Environment

1. **Clone the repository:**
   ```bash
   git clone https://github.com/midnightntwrk/midnight-faucet.git
   cd midnight-faucet
   ```

2. **Install dependencies:**
   ```bash
   yarn install
   ```

3. **Set up environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your local configuration if needed
   ```

4. **Run the full stack:**
   ```bash
   docker-compose up
   ```

   Or for UI development only:
   ```bash
   cd apps/ui
   yarn start
   ```

## Development Workflow

### Branch Naming

We use Git Flow with these branch prefixes:

- `feature/` — New features (e.g., `feature/add-rate-limiting`)
- `fix/` — Bug fixes (e.g., `fix/transaction-validation`)
- `refactor/` — Code cleanup without behavior change
- `docs/` — Documentation updates
- `chore/` — Dependency updates, tooling changes

Base your branches on `develop`:
```bash
git checkout develop
git pull origin develop
git checkout -b feature/your-feature-name
```

### Building and Testing

```bash
# Build all packages
yarn build

# Type checking
yarn typecheck

# Linting (must pass with --max-warnings=0)
yarn lint

# Run all tests
yarn test

# Run specific test
yarn test -t "test name pattern"

# Run single file
yarn test path/to/file.spec.ts

# Linting in a workspace
cd packages/faucet
yarn lint

# Format code
yarn format
```

### Running Tests

```bash
# Unit tests
yarn test

# E2E tests (requires docker-compose running)
cd tests
yarn e2e-test

# Smoke tests against deployed environment
cd tests
FAUCET_URL=https://faucet.preview.midnight.network yarn smoke-test
```

## Code Style

We enforce consistency through automated tools:

### ESLint Configuration
- Rules in `.eslintrc.json` (ESLint v10+)
- Plugin: `@typescript-eslint`
- Config: `eslint-config-turbo`

### Prettier Formatting
- 2-space indentation
- Single quotes (TypeScript files)
- Line width: 100 characters (configurable in `.prettierrc.json`)

**Before committing**, run:
```bash
yarn format
```

### TypeScript

- **Strict mode** enabled (`"strict": true`)
- **ESM throughout** (import/export syntax)
- **.js extensions in imports** are intentional (for Node.js ESM resolution)
- No `any` types without `// @ts-ignore-next-line` comments (with reason)

### Naming Conventions

- **Functions/variables**: `camelCase`
- **Classes/types**: `PascalCase`
- **Constants**: `CONSTANT_CASE` (only for true constants)
- **Files**: `kebab-case.ts` or `PascalCase.ts` for classes

### Comments

- Default: Write self-documenting code; minimal comments
- Only add comments for **why**, not **what**
- Complex algorithms, workarounds, or non-obvious behavior deserve comments

Example:
```typescript
// Bad: explains what the code does
const result = arr.filter(x => x > 5);  // Filter numbers greater than 5

// Good: explains why (if not obvious from context)
// Skip items below threshold due to wallet dust limit
const usableCoins = availableCoins.filter(c => c.value > dustThreshold);
```

## Architecture & Patterns

### Key Files to Understand

1. **`CLAUDE.md`** — Comprehensive architecture guide
2. **`apps/server/src/composition-root.ts`** — Dependency injection root
3. **`packages/faucet/src/FaucetImpl.ts`** — Core faucet logic
4. **`apps/server/src/TaskManager.ts`** — Transaction queue implementation

### Important Patterns

**Resource/Task Lifecycle:**
```typescript
// From @midnight-ntwrk/faucet-utils
import { Resource, Task, pipe } from "@midnight-ntwrk/faucet-utils";

const myResource = Resource.make(
  Task.lift(() => acquire()),  // Setup
  (acquired) => Task.lift(() => cleanup(acquired)),  // Teardown
);

pipe(myResource, Resource.use((resource) => Task.never));
```

**RxJS Observables:**
- Use `shareReplay({ bufferSize: 1, refCount: true })` for subscriptions shared across consumers
- Use `exhaustMap` for backpressure (skip intermediate emissions)
- Use `auditTime` to throttle high-frequency emissions (e.g., wallet state)

**Type Safety:**
- io-ts codecs for API request/response types
- Codecs are the source of truth; TypeScript types derive from them
- Example: `packages/faucet-internal-api/src/types.ts`

## Making Changes

### Writing Tests

All significant changes must include tests:

1. **Unit tests** for logic, pure functions
2. **Integration tests** for database, external service interactions
3. **E2E tests** for critical user flows

Test files:
- Use `.spec.ts` suffix
- Place next to the code they test
- Use Vitest syntax (similar to Jest)

Example:
```typescript
import { describe, it, expect } from "vitest";
import { mkRequestTokens } from "./FaucetImpl";

describe("mkRequestTokens", () => {
  it("should throw InsufficientFundsError when balance is low", async () => {
    const faucet = await setupTestFaucet({ balance: 100n });
    
    await expect(
      faucet.requestTokens("address", undefined, 1000n)
    ).rejects.toThrow(InsufficientFundsError);
  });
});
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`

**Scopes:** `server`, `faucet`, `wallet`, `api`, `ui`, `db`, etc.

**Subject:** 
- Lowercase, no period
- Imperative mood ("add" not "added")
- Under 50 characters

**Body** (optional):
- Explain *what* and *why*, not *how*
- Wrap at 72 characters
- Separate from subject with blank line

**Footer** (optional):
- Reference issues: `Fixes #123`, `Closes #456`
- Breaking changes: `BREAKING CHANGE: description`

**Examples:**
```
feat(faucet): add coin freshness validation before signing

Validate that selected coins still exist before transaction signing
to detect concurrent spending attempts. Throws InsufficientFundsError
with "coins no longer available" cause.

Fixes #102
```

```
fix(api): handle transaction history timeout gracefully

Log warning instead of failing request when transaction history
validation times out. The transaction may still succeed even if
history check fails.
```

## Submitting Changes

### Before Opening a PR

1. **Ensure tests pass:**
   ```bash
   yarn test
   ```

2. **Type-check:**
   ```bash
   yarn typecheck
   ```

3. **Lint and format:**
   ```bash
   yarn lint
   yarn format
   ```

4. **Run full check:**
   ```bash
   yarn check  # build + lint + test
   ```

5. **Test your changes locally** with `docker-compose up`

### Opening a Pull Request

1. **Push your branch:**
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Create a PR** with:
   - Clear title summarizing the change
   - Description explaining the *why* and *what*
   - Link to related issues (Fixes #123)
   - Checklist:
     ```markdown
     - [ ] Tests pass locally (`yarn test`)
     - [ ] Type checks pass (`yarn typecheck`)
     - [ ] Linting passes (`yarn lint`)
     - [ ] Code is formatted (`yarn format`)
     - [ ] New tests added for changes
     - [ ] Documentation updated (if needed)
     ```

3. **Respond to feedback** — maintainers may request changes

4. **Squash commits** if requested (one logical commit per feature)

### PR Review Process

- At least one maintainer review required
- CI checks must pass (build, lint, test)
- No breaking changes without discussion
- Changes to security-critical code require extra scrutiny

## Documentation

### When to Update Docs

- New features need documentation
- API changes require doc updates
- Architecture changes should be reflected in CLAUDE.md
- Non-obvious code patterns deserve explanation

### Documentation Files

- **README.md** — Quick start, overview, API reference
- **CLAUDE.md** — Architecture, patterns, file structure
- **CONTRIBUTING.md** — This file
- **THIRD_PARTY_API.md** — Partner integration guide
- **SECURITY.md** — Security policy and vulnerability reporting
- **CHANGELOG.md** — Release notes (generated from commits)

### Writing Docs

- Use Markdown
- Code examples should be tested/valid
- Keep language clear and concise
- Link to related docs

## Reporting Bugs

Found a security vulnerability? See [SECURITY.md](./SECURITY.md) for responsible disclosure.

For other bugs:

1. **Check existing issues** to avoid duplicates
2. **Create an issue** with:
   - Clear title
   - Steps to reproduce
   - Expected behavior
   - Actual behavior
   - Environment (Node version, OS, etc.)
   - Relevant logs or screenshots

## Feature Requests

Great ideas are welcome! Please:

1. **Open an issue** to discuss before coding
2. **Describe the use case** and benefits
3. **Consider alternatives** and tradeoffs
4. **Wait for feedback** before implementing

## Questions?

- **GitHub Issues** — For bug reports and feature requests
- **GitHub Discussions** — For questions and ideas
- **Security issues** — See [SECURITY.md](./SECURITY.md)

## Additional Resources

- [CLAUDE.md](./CLAUDE.md) — Complete architecture guide
- [SECURITY.md](./SECURITY.md) — Security policies
- [THIRD_PARTY_API.md](./THIRD_PARTY_API.md) — Partner API docs
- [Conventional Commits](https://www.conventionalcommits.org/)
- [Git Flow](https://nvie.com/posts/a-successful-git-branching-model/)

Thank you for contributing! 🙏
