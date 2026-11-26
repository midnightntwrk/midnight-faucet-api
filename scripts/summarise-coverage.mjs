#!/usr/bin/env node

/**
 * Coverage Summary
 *
 * Reads the per-workspace istanbul `coverage-final.json` files that CI aggregates into one
 * directory and writes a Markdown table to stdout, for the GitHub Actions step summary.
 *
 * Reporting only — it never exits non-zero on low coverage, so it cannot turn a passing build
 * red. Gate on a threshold in the vitest configs if that is wanted.
 *
 * Run with: node scripts/summarise-coverage.mjs <directory>
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const dir = process.argv[2];

if (!dir || !existsSync(dir)) {
  console.log("### Coverage\n\nNo coverage reports were produced.");
  process.exit(0);
}

/** Istanbul counter maps are `{ [id]: hitCount }`; covered means a non-zero count. */
const countHits = (counters) => {
  const values = Object.values(counters ?? {});
  return { total: values.length, covered: values.filter((hits) => hits > 0).length };
};

/** Branch counters nest one level deeper: `{ [id]: [hitCount, hitCount, ...] }`. */
const countBranchHits = (counters) => {
  const values = Object.values(counters ?? {}).flat();
  return { total: values.length, covered: values.filter((hits) => hits > 0).length };
};

const sum = (a, b) => ({ total: a.total + b.total, covered: a.covered + b.covered });

const percent = ({ total, covered }) => (total === 0 ? "—" : `${((covered / total) * 100).toFixed(1)}%`);

const summariseWorkspace = (fileCoverages) =>
  Object.values(fileCoverages).reduce(
    (acc, file) => ({
      statements: sum(acc.statements, countHits(file.s)),
      branches: sum(acc.branches, countBranchHits(file.b)),
      functions: sum(acc.functions, countHits(file.f)),
    }),
    {
      statements: { total: 0, covered: 0 },
      branches: { total: 0, covered: 0 },
      functions: { total: 0, covered: 0 },
    },
  );

const rows = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => {
    const workspace = name.replace(/-coverage-final\.json$/, "").replace(/\.json$/, "");
    try {
      return { workspace, ...summariseWorkspace(JSON.parse(readFileSync(join(dir, name), "utf8"))) };
    } catch (error) {
      return { workspace, error: error.message };
    }
  })
  .sort((a, b) => a.workspace.localeCompare(b.workspace));

if (rows.length === 0) {
  console.log("### Coverage\n\nNo coverage reports were produced.");
  process.exit(0);
}

const totals = rows
  .filter((row) => !row.error)
  .reduce(
    (acc, row) => ({
      statements: sum(acc.statements, row.statements),
      branches: sum(acc.branches, row.branches),
      functions: sum(acc.functions, row.functions),
    }),
    {
      statements: { total: 0, covered: 0 },
      branches: { total: 0, covered: 0 },
      functions: { total: 0, covered: 0 },
    },
  );

const line = (label, row) =>
  row.error
    ? `| ${label} | unreadable | unreadable | unreadable |`
    : `| ${label} | ${percent(row.statements)} | ${percent(row.branches)} | ${percent(row.functions)} |`;

console.log(
  [
    "### Coverage",
    "",
    "| Workspace | Statements | Branches | Functions |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => line(row.workspace, row)),
    line("**Total**", totals),
  ].join("\n"),
);
