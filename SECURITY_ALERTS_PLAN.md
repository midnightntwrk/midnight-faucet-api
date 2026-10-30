# Code Scanning Remediation Plan

**Repo:** `midnightntwrk/midnight-faucet-api`
**Open alerts at time of writing:** 74
**Assessed:** 2026-10-29, against `origin/main` @ `b097c42a`

---

## Executive summary

The 74 open alerts are **not** 74 outstanding defects. They break down as:

| Group                        | Count  | Status                                                   | Action                            |
| ---------------------------- | ------ | -------------------------------------------------------- | --------------------------------- |
| **A — Orphaned alerts**      | **60** | Frozen since 2026-08-07; scanners no longer report them   | Delete dead analyses (admin task) |
| **B — Trivy CVEs**           | **6**  | Real, live — **already fixed in open PR #156**            | Merge PR #156                     |
| **C — Scorecard posture**    | **8**  | Live; 6 are *passing* checks, 2 are actionable            | 1 real fix, rest are informational |

Only **one** group requires new code: a single unpinned `corepack@latest` in the Dockerfile.
Everything else is either already fixed and awaiting merge, or an artifact of a workflow rename.

**Net real security work remaining: ~1 line.**

---

## Group A — 60 orphaned alerts (the bulk of the problem)

### Root cause

The scan workflow was renamed `.github/workflows/scan.yml` → `.github/workflows/scan.yaml`
(commit `f05c6f2`, "chore: add open-source repository baseline").

GitHub tracks code-scanning alert state per **(tool, SARIF category)**. The category is derived from
the workflow path, so the rename silently split every tool into two independent alert streams:

```
.github/workflows/scan.yml:scan     ← dead; last analysis 2026-08-07T16:01Z @ 403ca51f
.github/workflows/scan.yaml:scan    ← live; last analysis 2026-10-29T00:06Z @ b097c42a
```

Alerts in the dead category can never be auto-closed, because no analysis will ever again be
uploaded under that category. They are frozen at `403ca51f` forever, regardless of how the code
changes.

### Evidence

The live scan on current `main` reports almost nothing:

| Tool            | Live results on `main` @ `b097c42a` | Orphaned alerts stuck at `403ca51f` |
| --------------- | ----------------------------------- | ----------------------------------- |
| Opengrep OSS    | 2 (both already dismissed)          | **28**                              |
| zizmor          | 1 (already dismissed)               | **24**                              |
| Gitleaks        | 0                                   | **7**                               |
| checkov         | 0                                   | **1**                               |
|                 |                                     | **60**                              |

Spot-checks confirm the orphaned findings are genuinely dead, not merely unreported:

- `.opengrep.yml:2` (insecure WebSocket) — **the file no longer exists.**
- `apps/server/src/middleware.ts:6`, `apps/server/src/postgres.ts:38` (path traversal via `path.join`)
  — neither file calls `path.join`/`path.resolve` any more; `middleware.ts` uses `pathToFileURL` +
  `new URL()`.
- `.github/workflows/CD.yml:108,130` (template injection) — now use step-level `env:` indirection
  with `"$TARGET_VERSION"`, the documented fix.
- `.github/workflows/smoke-devnet.yml:23` et al. (`secrets: inherit`) — all callers now enumerate
  secrets explicitly.
- `Dockerfile:1` (`CKV_DOCKER_2`, missing HEALTHCHECK) — `HEALTHCHECK` is present at line 27.
- 7 × Gitleaks — `.gitleaks.toml` was added 2026-10-26; live Gitleaks reports 0.

### Fix

Delete the analyses belonging to the dead `scan.yml` category. Deleting every analysis in an
analysis key removes its alerts outright (dismissal would leave 60 rows of noise behind instead).

There are 12 such analyses — 2 per tool, 6 tools:

| Analysis ID  | Tool          | Created              | Deletable |
| ------------ | ------------- | -------------------- | --------- |
| `1586707700` | zizmor        | 2026-08-07T16:01:00Z | yes       |
| `1586707681` | Trivy         | 2026-08-07T16:01:00Z | yes       |
| `1586707665` | ossf-scorecard| 2026-08-07T16:01:00Z | yes       |
| `1586707644` | Opengrep OSS  | 2026-08-07T16:01:00Z | yes       |
| `1586707616` | Gitleaks      | 2026-08-07T16:00:59Z | yes       |
| `1586707605` | checkov       | 2026-08-07T16:00:59Z | yes       |
| `1583379847` | zizmor        | 2026-08-07T01:11:40Z | after ↑   |
| `1583379787` | Trivy         | 2026-08-07T01:11:39Z | after ↑   |
| `1583379718` | ossf-scorecard| 2026-08-07T01:11:38Z | after ↑   |
| `1583379625` | Opengrep OSS  | 2026-08-07T01:11:37Z | after ↑   |
| `1583379550` | Gitleaks      | 2026-08-07T01:11:35Z | after ↑   |
| `1583379482` | checkov       | 2026-08-07T01:11:34Z | after ↑   |

Only the most recent analysis per key is deletable; delete it, then the next becomes deletable.
Walk each chain using the `next_analysis_url` returned by the delete call, and pass
`confirm_delete` on the final one.

```bash
# Per analysis, oldest-last. Requires security_events: write (repo admin / security manager).
gh api -X DELETE \
  "repos/midnightntwrk/midnight-faucet-api/code-scanning/analyses/1586707700?confirm_delete"
```

**Safety note.** The `ossf-scorecard` alerts (#1–#7, #45) survive this deletion: they carry
instances in *both* categories and their `most_recent_instance` is at live `main` (`b097c42a`),
so they remain open and correctly tracked. Only alerts whose sole instance lives in the dead
category disappear — exactly the 60 we want gone.

### Prevention

Two options, in order of preference:

1. **Pin the SARIF category explicitly** so it survives future workflow renames. The upload is
   handled by `midnightntwrk/upload-sarif-github-action@362d0346`; if it exposes a `category`
   input, set a stable literal (e.g. `scan`). If it does not, raise it upstream — this class of
   bug will recur on the next rename.
2. **Never rename a scanning workflow in place.** If one must be renamed, delete the old
   category's analyses in the same change.

Worth adding a line to `CONTRIBUTING.md` under the CI section either way.

---

## Group B — 6 Trivy CVEs (real, already fixed, awaiting merge)

All six are transitive npm advisories in `yarn.lock`. **PR #156 (`chore/no-ticket-rollup-bot-dependency-prs`)
already bumps every one of them** and is `OPEN` / `MERGEABLE`.

| Alert | Severity   | CVE               | Package       | `main` has | PR #156 has | Fixed in        |
| ----- | ---------- | ----------------- | ------------- | ---------- | ----------- | --------------- |
| #155  | **HIGH**   | CVE-2026-111181   | `body-parser` | 2.3.0      | **2.4.0** ✅ | 2.4.0 / 1.20.9  |
| #164  | MEDIUM     | CVE-2026-110816   | `qs`          | 6.16.0     | **6.16.1** ✅| 6.16.1          |
| #156  | MEDIUM     | CVE-2026-110180   | `fast-uri`    | 3.1.8      | **3.1.9** ✅ | 3.1.9           |
| #157  | MEDIUM     | CVE-2026-110306   | `fast-uri`    | 3.1.8      | **3.1.9** ✅ | 3.1.9           |
| #158  | LOW        | CVE-2026-110095   | `fast-uri`    | 3.1.8      | **3.1.9** ✅ | 3.1.9           |
| #159  | LOW        | CVE-2026-110725   | `fast-uri`    | 3.1.8      | **3.1.9** ✅ | 3.1.9           |

### Why #155 matters most

`body-parser` CVE-2026-111181 is a **remote unauthenticated DoS**. A request with
`Content-Encoding: gzip` carrying one valid frame plus trailing bytes leaves the decompression
stream without an error listener; the trailing bytes reach the finished decoder, which throws an
uncaught exception and **kills the process**. Body parsing runs before routing, so no valid route
is needed — every endpoint on the faucet API is reachable for this. For a public faucet this is a
one-request kill. Treat merging #156 as the priority item.

### The fixes are already pinned via `resolutions`

`package.json` carries workspace-wide `resolutions` for `body-parser: ^2.4.0`, `qs: ^6.14.2`, and
`fast-uri: ^3.1.8`, and `yarn.lock` on the branch resolves to 2.4.0 / 6.16.1 / 3.1.9 respectively.
No further dependency work is needed.

### The release-age gate is clear

`scan.yaml` notes that `npmMinimalAgeGate` quarantines a patch for 7 days. All three fixed versions
are past it as of 2026-10-29:

| Package              | Published      | Age     |
| -------------------- | -------------- | ------- |
| `body-parser@2.4.0`  | 2026-10-22     | 7 days  |
| `fast-uri@3.1.9`     | 2026-10-19     | 10 days |
| `qs@6.16.1`          | 2026-10-14     | 15 days |

`body-parser@2.4.0` is *exactly* at the boundary — if CI trips the age gate, re-run it rather than
reverting the bump.

### Action

Merge PR #156. All six alerts close automatically on the next `main` scan (scheduled daily at
00:00 UTC, and `push` to `main` also triggers it). Scorecard alert #7 ("10 existing vulnerabilities
detected") drops with them.

> The `differential_gate: "true"` setting means PR #156 passes because it strictly reduces the
> finding count, even though findings remain outstanding. That is the intended behaviour — do not
> interpret a green check as "zero findings".

---

## Group C — 8 OSSF Scorecard alerts (mostly informational)

These are repo-posture checks, all anchored at `README.md:1`. They are **not** code defects and
several are reporting *success* — Scorecard emits a SARIF result per check regardless of outcome.

| Alert | Check                   | Level | Message                                                   | Action                 |
| ----- | ----------------------- | ----- | --------------------------------------------------------- | ---------------------- |
| #1    | Binary-Artifacts        | note  | "no binaries found in the repo"                            | None — **passing**     |
| #2    | Dangerous-Workflow      | note  | "no dangerous workflow patterns detected"                  | None — **passing**     |
| #3    | License                 | note  | "license file detected"                                    | None — **passing**     |
| #5    | Security-Policy         | note  | "security policy file detected"                            | None — **passing**     |
| #6    | Token-Permissions       | note  | "tokens follow principle of least privilege"               | None — **passing**     |
| #45   | Dependency-Update-Tool  | note  | "update tool detected"                                     | None — **passing**     |
| #7    | Vulnerabilities         | warn  | "10 existing vulnerabilities detected"                      | Resolves with Group B  |
| #4    | Pinned-Dependencies     | note  | "dependency not pinned by hash — score normalized to 8"    | **One real fix**       |

### #4 — the only actionable item

Audit result: all 69 `uses:` references across `.github/workflows/` are SHA-pinned, and
`Dockerfile:1` pins `node:26.11.1@sha256:32fa97f3…`. The remaining deduction is:

```dockerfile
Dockerfile:12   RUN npm i -g corepack@0.36.0 && corepack enable   # pinned ✅
Dockerfile:19   RUN npm i -g corepack@latest \                    # UNPINNED ❌
```

Two build stages install `corepack`; the second uses `@latest`. Beyond the Scorecard score this is
a genuine supply-chain exposure — the image content is not reproducible and a compromised
`corepack` release lands in the published image without a diff.

**Fix:** pin line 19 to `corepack@0.36.0`, matching line 12.

Secondary, lower priority: `.github/workflows/ci.yml:37` runs `npm install -g npm@12.2.1`
(version-pinned but not hash-pinned), and the compose files reference `ghcr.io/midnight-ntwrk/*`
and `postgres:15`/`postgres:18` by tag rather than digest. These are dev/test-only surfaces and
digest-pinning them would fight the `update-stack` workflow that bumps those tags. Leave as-is
unless the Scorecard score needs to clear 9.

### Suppressing the six passing checks

The six `note`-level passes will reappear on every scan. Either accept them as permanent
informational rows, or trim `scorecard_checks` in `scan.yaml:46` to drop checks whose pass state
carries no signal. Recommendation: **leave them**. They are evidence the controls are in place, and
removing checks from the list weakens the gate.

---

## Execution order

| # | Step                                                           | Owner       | Effort | Closes      |
| - | -------------------------------------------------------------- | ----------- | ------ | ----------- |
| 1 | **Merge PR #156** — ships all 6 CVE bumps, incl. the HIGH DoS   | Vanessa     | ~0     | 6 (+#7)     |
| 2 | Pin `corepack@latest` → `corepack@0.36.0` in `Dockerfile:19`    | Vanessa     | 1 line | improves #4 |
| 3 | Delete the 12 orphaned `scan.yml`-category analyses             | Repo admin  | ~10min | **60**      |
| 4 | Pin the SARIF category (or file upstream issue on the action)   | Vanessa     | small  | prevention  |
| 5 | Note the rename hazard in `CONTRIBUTING.md`                     | Vanessa     | small  | prevention  |

Steps 1–3 are independent and can run in parallel.

**Projected end state: 8 open alerts** — the 8 Scorecard posture rows, of which 7 are passing
checks and 1 (#4) is a score note. No outstanding vulnerabilities.

---

## Verification

After steps 1–3, confirm with:

```bash
# Expect 8, all ossf-scorecard
gh api repos/midnightntwrk/midnight-faucet-api/code-scanning/alerts --paginate \
  -q '.[] | select(.state=="open") | .tool.name' | sort | uniq -c

# Expect a single live category
gh api 'repos/midnightntwrk/midnight-faucet-api/code-scanning/analyses?ref=refs/heads/main' \
  -q '.[].category' | sort -u
```

A scan runs on every push to `main` and daily at 00:00 UTC, so Group B closes within a day of
merge without manual intervention.

---

## Appendix — things deliberately *not* done

- **No bulk dismissal.** Dismissing the 60 orphans would leave them permanently visible as
  "dismissed" noise and would hide a genuine regression if one of those rules ever fires again
  under the live category. Deleting the dead analyses is the correct remedy.
- **No reverting of `differential_gate`.** The comment in `scan.yaml:39-43` documents why an
  absolute gate deadlocks against the 7-day `npmMinimalAgeGate`. That reasoning still holds.
- **No digest-pinning of stack images.** Would conflict with the `update-stack` tag-bump workflow.
