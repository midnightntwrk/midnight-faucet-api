# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs): short documents that preserve significant technical decisions and their reasoning.

## When to write an ADR

Write an ADR when a decision:

- Is difficult to reverse, such as a database schema or public API.
- Affects multiple services or teams.
- Chooses between credible alternatives.
- Introduces a major dependency, runtime, or protocol.
- Changes security, privacy, authentication, or key-management boundaries.

Do not write an ADR for formatting choices, routine upgrades, or bug fixes that do not change architecture.

## Process

1. Copy `0000-template.md` to `NNNN-short-title.md` using the next available number.
2. Open a pull request with status `Proposed` and request the relevant CODEOWNERS.
3. Discuss and revise the decision in the pull request.
4. Change the status to `Accepted` when the pull request is approved and merged.
5. Preserve superseded decisions and link them to their replacements.

## Index

| ADR | Title | Status | Date |
| --- | --- | --- | --- |
| 0000 | [Template](0000-template.md) | n/a | — |
