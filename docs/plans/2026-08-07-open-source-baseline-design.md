# Midnight Faucet API Open-Source Baseline Design

## Status

Approved on 2026-08-07.

## Objective

Bring `midnightntwrk/midnight-faucet-api` to the current open-source governance and security baseline without replacing Midnight Foundation identity, ownership, or disclosure policy with Shielded Technologies values.

## Source-of-truth hierarchy

1. `midnightntwrk/midnight-node` supplies Midnight-specific policy data, including the Midnight Foundation security contact, organization links, contributor language, and CODEOWNERS team conventions.
2. `shieldedtech/open-source-governance` and `shieldedtech/shielded-template-repo` supply the current structure and control coverage for files that `midnight-node` predates.
3. Existing `midnight-faucet-api` application documentation and workflows are preserved unless a change is required for governance or enforcement.

The current Shielded audit script hard-codes `shielded.io` and `@shieldedtech/*` content checks. Those checks are not authoritative for a `midnightntwrk` repository and will be reported as known false positives until a Midnight-aware audit is created.

## Repository changes

The repository pull request will add or update:

- Midnight Foundation versions of `CODE_OF_CONDUCT.md`, `CODEOWNERS`, `SECURITY.md`, `SUPPORT.md`, `NOTICE`, and `THIRD_PARTY_NOTICES.md`.
- Contributor-facing issue forms, issue-template configuration, and a pull-request template.
- Dependabot and release configuration.
- `CHANGELOG.md` and ADR index/template files.
- A canonical `scan.yaml` workflow while preserving the repository's existing scan behavior and pinned-action policy.
- A pinned `.pre-commit-config.yaml` and a matching CI workflow so enforcement does not depend on contributors installing local hooks.
- Contributor instructions that explicitly install and run pre-commit.

No application behavior, deployment configuration, or published API contract is intentionally changed.

## GitHub and IaC changes

GitHub settings remain controlled by `midnightntwrk/midnight-iac`. A companion IaC pull request will:

- Reconcile the `main` branch protection already declared in code but missing from the live repository.
- Require the stable CI, scan, and pre-commit checks after the workflows exist.
- Enable private vulnerability reporting through the existing IaC mechanism.
- Codify read-only default GitHub Actions permissions and prevent Actions from approving pull-request reviews when the provider supports those controls cleanly.
- Make the canonical `bot:ai-assisted` disclosure label available through IaC rather than an out-of-band GitHub mutation.
- Avoid duplicating Dependabot security-update work already covered by `midnight-iac` PR #271.

The IaC plan must not contain destroys, replacements, or unrelated collaborator changes.

## Ownership

`CODEOWNERS` will follow the `midnight-node` pattern:

- The repository-wide owner will be an existing Midnight engineering owner appropriate for the faucet.
- Security-sensitive and repository-governance paths will additionally require `mn-security` and `mn-sre` review.
- Only teams confirmed to exist in the `midnightntwrk` organization and to have repository access will be referenced.

## Validation

Repository validation will include:

- The canonical open-source audit, with Shielded-branded content checks classified as non-applicable rather than remediated with incorrect values.
- A full-history secret scan.
- `pre-commit run --all-files`.
- Action syntax and pinned-action validation.
- The repository's build, typecheck, lint, and test commands.

IaC validation will include formatting, pre-commit, OpenTofu validation, and a reviewed plan confirming only the intended in-place controls.

## Delivery

Delivery consists of one `midnight-faucet-api` pull request for repository content and one `midnight-iac` pull request for settings. Both will link their tracking issues, disclose AI assistance through the required label and commit trailer, and remain open for human review and application.
