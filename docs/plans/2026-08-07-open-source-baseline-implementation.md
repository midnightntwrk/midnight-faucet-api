# Midnight Faucet API Open-Source Baseline Implementation Plan

> **Execution:** Complete each task in order and retain command output as PR evidence.

**Goal:** Add the complete Midnight open-source repository baseline and codify the corresponding GitHub controls in `midnight-iac`.

**Architecture:** Repository-owned policy, templates, and CI live in `midnight-faucet-api`. Organization and repository settings remain in `midnight-iac`. Midnight-specific policy values come from `midnight-node`; newer file structure comes from the current governance template.

**Tooling:** Markdown/YAML, pre-commit, GitHub Actions, OpenTofu, GitHub provider, `gh`, actionlint, gitleaks.

## Task 1: Add governance and contributor files

**Files:**

- Create: `CODE_OF_CONDUCT.md`
- Create: `CODEOWNERS`
- Update: `SECURITY.md`
- Create: `SUPPORT.md`
- Create: `NOTICE`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `CHANGELOG.md`
- Update: `CONTRIBUTING.md`

**Steps:**

1. Adapt Midnight Foundation wording and contacts from `midnight-node`.
2. Use verified Midnight teams in CODEOWNERS.
3. Add pre-commit installation and execution instructions without adding AI DCO sign-off.
4. Run Markdown and whitespace validation.

## Task 2: Add contribution and release templates

**Files:**

- Create: `.github/ISSUE_TEMPLATE/config.yml`
- Create: `.github/ISSUE_TEMPLATE/bug-report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature-request.yml`
- Create: `.github/ISSUE_TEMPLATE/documentation-improvement.yml`
- Create: `.github/PULL_REQUEST_TEMPLATE/pull_request_template.md`
- Create: `.github/release.yml`
- Create: `docs/adr/README.md`
- Create: `docs/adr/0000-template.md`

**Steps:**

1. Adapt current governance templates to Midnight URLs and contacts.
2. Use only labels that are present now or managed by the companion IaC change.
3. Remove stale Project Priority-field instructions; retain the approved native issue priority input.
4. Validate YAML and Markdown.

## Task 3: Add dependency, scan, and pre-commit enforcement

**Files:**

- Create: `.github/dependabot.yml`
- Rename/update: `.github/workflows/scan.yml` to `.github/workflows/scan.yaml`
- Create: `.pre-commit-config.yaml`
- Create: `.github/workflows/pre-commit.yml`

**Steps:**

1. Configure npm, Docker, and GitHub Actions update coverage with cooldown and grouping appropriate to this monorepo.
2. Preserve the existing Midnight scanner action and permissions while exposing the canonical `scan` check.
3. Configure pinned pre-commit hooks for file hygiene, YAML/JSON validation, secret detection, and actionlint.
4. Pin every third-party GitHub Action to a full commit SHA.
5. Install hooks and run `pre-commit run --all-files` until clean.

## Task 4: Codify GitHub settings in midnight-iac

**Files:**

- Update: `github/midnightntwrk/repos_midnight.tf`
- Update: `github/midnightntwrk/repo_security.tf`
- Update: `github/midnightntwrk/labels.tf`
- Update module/provider files only if required for Actions workflow-permission controls.

**Steps:**

1. Start from current `origin/main` in a dedicated branch and install pre-commit.
2. Add canonical labels for `midnight-faucet-api`, importing existing collisions if required.
3. Require stable CI, scan, and pre-commit contexts on protected `main`.
4. Add private vulnerability reporting to the existing managed map.
5. Add Actions default-permission controls only if the provider exposes them without out-of-band scripting.
6. Run formatting, pre-commit, validation, and a targeted plan; reject any destroy/replacement or unrelated collaborator change.

## Task 5: Validate and publish

**Steps:**

1. Run the source repository build, typecheck, lint, and tests.
2. Run actionlint and the full open-source audit; classify only the hard-coded Shielded identity checks as non-applicable.
3. Run a full-history secret scan.
4. Review diffs against `origin/main` and verify signed commits contain `Assisted-by` trailers but no AI DCO sign-off.
5. Create/link tracking issues, push branches, and open one source PR plus one IaC PR.
6. Add `bot:ai-assisted` where available, inspect checks, and fix failures caused by these changes.
