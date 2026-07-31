# Coding Conventions — Midnight Faucet

The single source of truth for how code is written in this repository. [`CONTRIBUTING.md`](../CONTRIBUTING.md) links
here for the day-to-day workflow, and the root [`CLAUDE.md`](../CLAUDE.md) imports this file so coding agents load these
rules automatically. Keep all three in sync when conventions change.

Anything a tool already enforces (Prettier formatting, ESLint rules) is **not** repeated here as a rule you must
remember — run `yarn format` and `yarn lint` and let them do their job. This document is for the conventions that
tooling does **not** catch.

---

## TypeScript

- **Strict mode** is enabled (`"strict": true`) — keep it satisfied rather than working around it.
- **ESM throughout** — `import`/`export` syntax only.
- **`.js` extensions in imports are intentional** — required for Node.js ESM resolution. Do not "fix" them to
  extensionless imports.
- **No `any`.** If you genuinely cannot avoid it, suppress the single line with `// @ts-ignore-next-line` **and a reason**
  — never a blanket disable.

## Naming

| Kind                | Convention                                       |
| ------------------- | ------------------------------------------------ |
| Functions / variables | `camelCase`                                    |
| Classes / types     | `PascalCase`                                      |
| Constants           | `CONSTANT_CASE` (only for _true_ constants)       |
| Files               | `kebab-case.ts`, or `PascalCase.ts` for classes   |

A name should reveal what the thing does or holds. If no honest name comes, the design is usually murky — fix that first.

## Comments

- Default to **self-documenting code**; keep comments minimal.
- Comment the **why**, not the **what**. The code already says what it does.
- Complex algorithms, workarounds, and non-obvious behaviour genuinely deserve a comment.

```typescript
// Bad: restates the code
const result = arr.filter((x) => x > 5); // filter numbers greater than 5

// Good: explains the why
// Skip items below threshold due to wallet dust limit
const usableCoins = availableCoins.filter((c) => c.value > dustThreshold);
```

## Tests

- Use the `.spec.ts` suffix, placed **next to** the code they test.
- Vitest syntax (Jest-like).
- Every significant change ships with tests: unit tests for logic/pure functions, integration tests for DB/external
  services, e2e for critical user flows.

## Architecture patterns

The stack is **fp-ts** + **RxJS** + **io-ts**. Follow the patterns already established in the codebase:

- **Resource / Task lifecycle** (`@midnight-ntwrk/faucet-utils`) — acquire/release pairs via `Resource.make`, run with
  `Resource.use`. See existing usage in `apps/server/src/composition-root.ts`.
- **RxJS observables** — `shareReplay({ bufferSize: 1, refCount: true })` for subscriptions shared across consumers;
  `exhaustMap` for backpressure; `auditTime` to throttle high-frequency emissions (e.g. wallet state).
- **io-ts codecs are the source of truth** for API request/response types — TypeScript types derive from the codecs, not
  the other way round. See `packages/faucet-internal-api/src/types.ts`.

## Key files

Where to start reading:

- `apps/server/src/composition-root.ts` — dependency-injection root; wires the server together.
- `packages/faucet/src/FaucetImpl.ts` — core faucet logic.
- `apps/server/src/TaskManager.ts` — the dispense queue and rate-limit slot lifecycle.
- `packages/faucet-internal-api/src/types.ts` — io-ts codecs / shared API types (the source of truth).

---

## Functional conventions

Conventions for writing side-effect-free code with this repo's tools (fp-ts / RxJS / io-ts). Some existing code predates
these; new code should follow them.

### Immutability: `const` only, never `let` (the headline rule)

**Write side-effect-free code by default.** Prefer pure transformations over mutation.

**Avoid:**

- `let` declarations — use `const`.
- `for` / `while` loops that accumulate into a mutated variable — use `map` / `filter` / `reduce` / `flatMap`.
- `array.push()` / `pop()` / `splice()` and `object[key] = value` mutations — build new values instead.
- `result` variables mutated inside a loop.

**Prefer:**

- `const` for every declaration.
- `array.map` / `filter` / `reduce` / `flatMap` / `some` / `every` to transform, select, accumulate, and test.
- Spread syntax `{ ...obj, key: value }` / `[...arr, item]` to produce modified copies.
- `Array.from(...)` to materialise iterables.

```typescript
// WRONG: mutation with let + push
let total = 0n;
const names: string[] = [];
for (const item of items) {
  total += item.value;
  if (item.active) names.push(item.name);
}

// RIGHT: pure functional
const total = items.reduce((sum, item) => sum + item.value, 0n);
const names = items.filter((item) => item.active).map((item) => item.name);
```

**The only accepted exceptions** (isolate them and comment why):

- Measured performance-critical inner loops (rare).
- Bridging to an inherently mutable external API.
- Test setup/teardown.

### Parse, don't validate

Prefer `parse(input): TypedValue | Error` over `validate(input): boolean`. A parsed, typed value makes invalid states
unrepresentable, and the caller cannot accidentally keep using the raw input. In this repo that is exactly what **io-ts
codecs** give you — decode into the domain type rather than checking a raw value and carrying on.

### Make illegal states unrepresentable

Design types so invalid combinations cannot be constructed.

```typescript
// WRONG: both optional, unclear which combinations are valid
type Result = { data?: Data; error?: Error };

// RIGHT: exactly one state is valid
type Result = { _tag: 'success'; data: Data } | { _tag: 'failure'; error: Error };
```

### Total functions

A function should be defined for every input of its declared type. Don't throw for _expected_ conditions — return an
`Option` (fp-ts) for "might not exist" and `Either` for "might fail", or restrict the input type so the bad case can't
arise (e.g. a non-empty array type).

### Avoid type casts

`as Type` bypasses the type checker and hides bugs. Exhaust the alternatives first — fix the underlying types, narrow
with a type guard, use generics properly. If a cast is genuinely unavoidable, it must carry a justification comment:

```typescript
// Type cast required because: <specific reason no alternative exists>
const value = someValue as SomeType;
```
