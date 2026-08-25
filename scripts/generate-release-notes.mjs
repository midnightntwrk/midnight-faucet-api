#!/usr/bin/env node

/**
 * Release Notes Generator
 *
 * Generates RELEASE_NOTES.md from package versions, git history, and a template.
 * Run with: node scripts/generate-release-notes.js [--env <environment>]
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");

// Parse command line arguments
const args = process.argv.slice(2);
const envIndex = args.indexOf("--env");
const environment = envIndex !== -1 ? args[envIndex + 1] : "Preprod, Preview";

/**
 * Read package.json and return parsed content
 */
function readPackageJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Get all workspace packages with their versions and descriptions
 */
function getPackages() {
  const packages = [];
  const dirs = [
    { path: "apps/server", name: "@midnight-ntwrk/faucet-server" },
    { path: "apps/ui", name: "@midnight-ntwrk/faucet-ui" },
    { path: "packages/faucet", name: "@midnight-ntwrk/faucet" },
    { path: "packages/faucet-client", name: "@midnight-ntwrk/faucet-client" },
    { path: "packages/auth", name: "@midnight-ntwrk/faucet-auth" },
    { path: "packages/faucet-internal-api", name: "@midnight-ntwrk/faucet-internal-api" },
    { path: "packages/faucet-utils", name: "@midnight-ntwrk/faucet-utils" },
  ];

  const descriptions = {
    "@midnight-ntwrk/faucet-server":
      "HTTP server for token distribution with REST API, rate limiting, and async task processing.",
    "@midnight-ntwrk/faucet-ui":
      "React web interface for requesting test tokens with CAPTCHA protection.",
    "@midnight-ntwrk/faucet-client":
      "TypeScript client library for programmatic faucet access.",
    "@midnight-ntwrk/faucet":
      "Core faucet library with wallet integration and token transfer logic.",
    "@midnight-ntwrk/faucet-auth": "JWT-based authentication for faucet API access.",
    "@midnight-ntwrk/faucet-internal-api":
      "Shared API types and codecs for client-server communication.",
    "@midnight-ntwrk/faucet-utils":
      "Common utilities for functional programming patterns and testing.",
  };

  for (const dir of dirs) {
    const pkgPath = join(ROOT_DIR, dir.path, "package.json");
    const pkg = readPackageJson(pkgPath);
    if (pkg) {
      packages.push({
        name: pkg.name || dir.name,
        version: pkg.version,
        description: descriptions[pkg.name] || pkg.description || "",
      });
    }
  }

  return packages;
}

/**
 * Get commits since last tag
 */
function getCommitsSinceLastTag() {
  try {
    // Get the last tag
    const lastTag = execSync("git describe --tags --abbrev=0 HEAD^ 2>/dev/null || echo ''", {
      cwd: ROOT_DIR,
      encoding: "utf-8",
    }).trim();

    if (!lastTag) {
      // No previous tag, get last 20 commits
      return execSync('git log -20 --pretty=format:"%s"', {
        cwd: ROOT_DIR,
        encoding: "utf-8",
      })
        .split("\n")
        .filter(Boolean);
    }

    return execSync(`git log ${lastTag}..HEAD --pretty=format:"%s"`, {
      cwd: ROOT_DIR,
      encoding: "utf-8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Categorize commits into sections
 */
function categorizeCommits(commits) {
  const categories = {
    features: [],
    fixes: [],
    improvements: [],
    other: [],
  };

  for (const commit of commits) {
    const lower = commit.toLowerCase();
    if (lower.startsWith("feat") || lower.includes("add ") || lower.includes("new ")) {
      categories.features.push(commit);
    } else if (lower.startsWith("fix") || lower.includes("fix ")) {
      categories.fixes.push(commit);
    } else if (
      lower.startsWith("chore") ||
      lower.startsWith("refactor") ||
      lower.includes("update") ||
      lower.includes("improve")
    ) {
      categories.improvements.push(commit);
    } else {
      categories.other.push(commit);
    }
  }

  return categories;
}

/**
 * Format date as "YYYY-MM-DD"
 */
function formatDate(date) {
  return date.toISOString().split("T")[0];
}

/**
 * Generate the release notes markdown
 */
function generateReleaseNotes() {
  const rootPkg = readPackageJson(join(ROOT_DIR, "package.json"));
  const version = rootPkg?.version || "0.0.0";
  const date = formatDate(new Date());
  const packages = getPackages();
  const commits = getCommitsSinceLastTag();
  const categorized = categorizeCommits(commits);

  // Build improvements list
  const improvementsList =
    categorized.improvements.length > 0
      ? categorized.improvements.map((c) => `- ${c}`).join("\n")
      : "N/A for this release.";

  // Build fixes list
  const fixesList =
    categorized.fixes.length > 0
      ? categorized.fixes.map((c) => `- ${c}`).join("\n")
      : "N/A for this release.";

  // Build packages table
  const packagesTable = packages
    .map((p) => `| \`${p.name}\` | ${p.version} | ${p.description} |`)
    .join("\n");

  const template = `# Release Notes
**Version:** ${version} **Date:** ${date} **Environment:** ${environment}
---
### Summary
#### The Midnight Faucet is a token distribution service for the Midnight Network testnet environments. It enables developers and testers to request test tokens for their wallets, supporting both web-based and programmatic access.
---
### Improvements
${improvementsList}
---
### Packages
| Package | Version | Description |
| ------- | ------- | ----------- |
${packagesTable}
---
### Links and references
- GitHub Repository: [midnightntwrk/midnight-faucet-api](https://github.com/midnightntwrk/midnight-faucet-api)
- Midnight Network Documentation: [docs.midnight.network](https://docs.midnight.network)
- Wallet SDK: [midnightntwrk/midnight-wallet](https://github.com/midnightntwrk/midnight-wallet)
---
### Fixed defect list
${fixesList}
`;

  return template;
}

// Main execution
const releaseNotes = generateReleaseNotes();
const outputPath = join(ROOT_DIR, "RELEASE_NOTES.md");
writeFileSync(outputPath, releaseNotes);
console.log(`Release notes generated: ${outputPath}`);
