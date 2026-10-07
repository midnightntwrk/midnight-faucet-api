#!/usr/bin/env node

/**
 * Release Notes Generator
 *
 * Generates RELEASE_NOTES.md in the shape of the component release-note template, filling every
 * field that can be derived from the repository and the GitHub API. Fields that depend on operator
 * knowledge the repository does not hold are written as `TODO: … (owner)` for a human to replace.
 *
 * Run with: node scripts/generate-release-notes.mjs [--env <environment>] [--version <ver>]
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const REPO = "midnightntwrk/midnight-faucet-api";

/** Workspace packages, in the order the release note lists them. */
const WORKSPACE_PACKAGES = [
  { dir: "apps/server", name: "@midnightntwrk/faucet-server" },
  { dir: "apps/ui", name: "@midnightntwrk/faucet-ui" },
  { dir: "packages/faucet", name: "@midnightntwrk/faucet" },
  { dir: "packages/faucet-client", name: "@midnightntwrk/faucet-client" },
  { dir: "packages/auth", name: "@midnightntwrk/faucet-auth" },
  { dir: "packages/faucet-internal-api", name: "@midnightntwrk/faucet-internal-api" },
  { dir: "packages/faucet-utils", name: "@midnightntwrk/faucet-utils" },
];

/** Dependencies reported in the Tested-with table, resolved from the lockfile. */
const TESTED_WITH_PACKAGES = ["@midnightntwrk/wallet-sdk", "@midnightntwrk/ledger-v9"];

/** Stack images reported in the Tested-with table, read from the deployment compose files. */
const TESTED_WITH_IMAGES = ["midnight-node", "indexer-standalone", "proof-server"];

/**
 * Compose files that describe how this release is actually deployed and end-to-end tested.
 * `packages/faucet/test-compose.yml` is deliberately excluded — it pins an older stack for unit
 * tests, and folding it in would understate the versions the release was validated against.
 */
const DEPLOYMENT_COMPOSE_FILES = ["docker-compose.yml", "tests/docker-compose-dynamic.yml"];

const args = process.argv.slice(2);

const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

/**
 * `gh` is the only network dependency. A failed call returns null rather than throwing so a single
 * unreachable PR degrades one line instead of losing the whole note.
 */
const gh = (apiArgs) => {
  try {
    return JSON.parse(execFileSync("gh", apiArgs, { cwd: ROOT_DIR, encoding: "utf-8" }));
  } catch {
    return null;
  }
};

const headSha = () =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT_DIR, encoding: "utf-8" }).trim();

const todo = (need) => `TODO: ${need} (owner)`;

const isPreRelease = (version) => version.includes("-");

const baseVersion = (version) => version.split("-")[0];

/** Semver delta against the previous published release, for the automation-driving Metadata line. */
const releaseType = (version, previousVersion) => {
  const [major, minor] = baseVersion(version).split(".").map(Number);
  const [prevMajor, prevMinor] = baseVersion(previousVersion).split(".").map(Number);
  if (major !== prevMajor) return "major";
  if (minor !== prevMinor) return "minor";
  return "patch";
};

/**
 * The baseline is the newest published release that is not a pre-release of the version being
 * drafted. Anchoring to the immediately preceding tag instead would make an rc chain report only
 * its own version bump, hiding the whole line from anyone upgrading from the last shipped release.
 */
const resolveBaseline = (version, releases) => {
  const target = baseVersion(version);
  return releases.find(
    (release) => baseVersion(release.version) !== target || !isPreRelease(release.version),
  );
};

/** Earlier pre-releases of the same version, whose announced content must not be repeated as new. */
const priorPreReleases = (version, releases) =>
  releases.filter(
    (release) =>
      baseVersion(release.version) === baseVersion(version) &&
      isPreRelease(release.version) &&
      release.version !== version,
  );

const normaliseTitle = (title) =>
  title
    .toLowerCase()
    .replace(/^merge pull request #\d+ from \S+\s*/, "")
    .replace(/\s*\(#\d+\)$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * A prior release body announces work either by PR number or — as this generator used to — by bare
 * commit subject. Matching on both is what stops an already-shipped fix being re-announced as new.
 */
const announcedBy = (prior) => ({
  numbers: new Set(Array.from(prior.body.matchAll(/#(\d+)/g)).map((match) => Number(match[1]))),
  titles: new Set(
    prior.body
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => normaliseTitle(line.slice(2)))
      .filter(Boolean),
  ),
});

const announcedIn = (pr, priors) =>
  priors.find((prior) => {
    const announced = announcedBy(prior);
    return announced.numbers.has(pr.number) || announced.titles.has(normaliseTitle(pr.title));
  })?.version ?? null;

const hasLabel = (pr, label) => pr.labels.includes(label);

const isDependencyNoise = (pr) => hasLabel(pr, "bot:dependencies") || /^chore\(deps/.test(pr.title);

const isVersionBump = (pr) => /^chore(\(.+\))?: ?(re)?update (all )?version/i.test(pr.title);

const isBreaking = (pr) => /^[a-z]+(\(.+\))?!:/.test(pr.title) || /BREAKING CHANGE/.test(pr.body);

/** Classification is label- and prefix-driven; anything unrecognised lands in `other` for review. */
const classify = (pr) => {
  if (isBreaking(pr)) return "breaking";
  if (isVersionBump(pr)) return "versionBump";
  if (isDependencyNoise(pr)) return "dependencies";
  if (/^feat/.test(pr.title)) return "features";
  if (/^fix/.test(pr.title)) return "fixes";
  if (/^(perf|refactor|chore|docs|ci|build|test)/.test(pr.title)) return "improvements";
  return "other";
};

const closesIssues = (pr) =>
  Array.from(pr.body.matchAll(/\b(?:closes|fixes|resolves)\s+#(\d+)/gi)).map((match) =>
    Number(match[1]),
  );

const securityIds = (prs) =>
  Array.from(
    new Set(
      prs.flatMap((pr) =>
        Array.from(pr.body.matchAll(/\b(?:CVE-\d{4}-\d{4,}|GHSA(?:-[a-z0-9]{4}){3})\b/gi)).map(
          (match) => match[0],
        ),
      ),
    ),
  );

/** Resolved lockfile versions — build pins, not QA-verified. */
const lockfilePins = (packageNames) => {
  const lockfile = existsSync(join(ROOT_DIR, "yarn.lock"))
    ? readFileSync(join(ROOT_DIR, "yarn.lock"), "utf-8")
    : "";
  return packageNames
    .map((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = lockfile.match(new RegExp(`"${escaped}@npm:[^"]*":\\n  version: (\\S+)`));
      return match ? { name, version: match[1] } : null;
    })
    .filter(Boolean);
};

/**
 * Stack image pins, read from the deployment compose files. A pin only enters the table when every
 * compose file that mentions the image agrees — a split pin is reported as a discrepancy instead,
 * because claiming one of two versions would misstate what the release was tested against.
 */
const imagePins = (imageNames) => {
  const contents = DEPLOYMENT_COMPOSE_FILES.filter((file) => existsSync(join(ROOT_DIR, file))).map(
    (file) => readFileSync(join(ROOT_DIR, file), "utf-8"),
  );

  return imageNames
    .map((image) => {
      const pattern = new RegExp(`image:\\s*"?([^\\s"]*${image}:[^\\s"]+)"?`, "g");
      const refs = Array.from(
        new Set(contents.flatMap((text) => Array.from(text.matchAll(pattern)).map((m) => m[1]))),
      );
      if (refs.length === 0) return null;
      return {
        name: refs[0].split(":")[0],
        version: refs[0].split(":").slice(1).join(":"),
        agreed: refs.length === 1,
      };
    })
    .filter(Boolean);
};

/**
 * The package table lists source versions, which is not the same as the set of installable
 * artifacts. Only packages the registry actually serves at this version are reported as released.
 */
const publishedArtifacts = (packages, version) =>
  packages.filter((pkg) => {
    const manifest = readJson(join(ROOT_DIR, pkg.dir, "package.json"));
    if (!manifest || manifest.private === true) return false;
    try {
      execFileSync("npm", ["view", `${pkg.name}@${version}`, "version"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return true;
    } catch {
      return false;
    }
  });

const prLine = (pr, priors) => {
  const prior = announcedIn(pr, priors);
  return `- ${pr.title} (PR #${pr.number}${prior ? `, announced in ${prior}` : ""}).`;
};

const section = (heading, body) => `## ${heading}\n\n${body}\n`;

const generate = () => {
  const environment = flag("env", "Preprod, Preview");
  const rootPkg = readJson(join(ROOT_DIR, "package.json"));
  const version = flag("version", rootPkg?.version);
  if (!version) {
    console.error("generate-release-notes: could not determine the version to draft");
    process.exit(2);
  }

  const allReleases = (gh(["api", `repos/${REPO}/releases?per_page=100`]) ?? []).map((release) => ({
    version: release.tag_name.replace(/^v/, ""),
    tag: release.tag_name,
    publishedAt: release.published_at,
    body: release.body ?? "",
  }));

  const thisRelease = allReleases.find((release) => release.version === version);

  // Newest-first, and strictly older than the target. Re-generating an older release must not pick
  // a later one as its baseline, which plain "everything except this version" would allow.
  const earlier = allReleases
    .filter(
      (release) =>
        release.version !== version &&
        (!thisRelease || release.publishedAt < thisRelease.publishedAt),
    )
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  const baseline = resolveBaseline(version, earlier);
  const priors = priorPreReleases(version, earlier);

  if (!baseline) {
    console.error(`generate-release-notes: no baseline release found before ${version}`);
    process.exit(2);
  }

  // On a release the checkout is at the tag, so the tag resolves. On a manual dispatch from a
  // branch the version is usually ahead of every tag, so compare against the checked-out commit
  // instead — that previews the note for work that has not been tagged yet.
  const head = thisRelease ? thisRelease.tag : headSha();
  const compare = gh(["api", `repos/${REPO}/compare/${baseline.tag}...${head}`]);
  if (!compare) {
    console.error(`generate-release-notes: could not compare ${baseline.tag}...${head}`);
    process.exit(2);
  }

  const prNumbers = Array.from(
    new Set(
      compare.commits.flatMap((commit) =>
        Array.from(commit.commit.message.matchAll(/(?:Merge pull request #|\(#)(\d+)/g)).map(
          (match) => Number(match[1]),
        ),
      ),
    ),
  );

  const prs = prNumbers
    .map((number) => gh(["api", `repos/${REPO}/pulls/${number}`]))
    .filter(Boolean)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      mergedAt: pr.merged_at,
      labels: (pr.labels ?? []).map((label) => label.name),
    }))
    .filter((pr) => pr.mergedAt)
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));

  const grouped = prs.reduce(
    (acc, pr) => ({ ...acc, [classify(pr)]: [...(acc[classify(pr)] ?? []), pr] }),
    {},
  );
  const take = (key) => grouped[key] ?? [];
  const fresh = (list) => list.filter((pr) => !announcedIn(pr, priors));
  const repeated = (list) => list.filter((pr) => announcedIn(pr, priors));

  const date = (thisRelease?.publishedAt ?? new Date().toISOString()).split("T")[0];
  const pins = lockfilePins(TESTED_WITH_PACKAGES);
  const images = imagePins(TESTED_WITH_IMAGES);
  const artifacts = publishedArtifacts(WORKSPACE_PACKAGES, version);
  const ids = securityIds(prs);

  const sourceRef = thisRelease
    ? `source tag [${thisRelease.tag}](https://github.com/${REPO}/releases/tag/${thisRelease.tag})`
    : `source commit [${head.slice(0, 7)}](https://github.com/${REPO}/commit/${head}) — not yet tagged`;

  const changeLines = [
    ...fresh([
      ...take("features"),
      ...take("fixes"),
      ...take("improvements"),
      ...take("other"),
    ]).map((pr) => prLine(pr, priors)),
    ...(fresh(take("dependencies")).length > 0
      ? [
          `- Routine dependency maintenance (${fresh(take("dependencies"))
            .map((pr) => `PR #${pr.number}`)
            .join(", ")}).`,
        ]
      : []),
    ...(fresh(take("versionBump")).length > 0
      ? [
          `- Advanced the version string to ${version} across the workspace manifests; no functional change (${fresh(
            take("versionBump"),
          )
            .map((pr) => `PR #${pr.number}`)
            .join(", ")}).`,
        ]
      : []),
  ];

  const repeatedLines = repeated(prs)
    .filter((pr) => classify(pr) !== "versionBump")
    .map((pr) => prLine(pr, priors));

  const body = [
    `# faucet ${version}`,
    ``,
    section(
      "Metadata",
      [
        `- **Release type**: ${releaseType(version, baseline.version)}`,
        `  Derived from the ${baseline.version} to ${baseVersion(version)} semver delta.`,
        `- **Date**: ${date}`,
        `- **Ships in bundle**: ${todo("name the bundle line and link its bundle RN, or state that it is not bundled")}`,
        `- **Sister-line note**: — no parallel maintenance line exists for this component.`,
        `- **Environment**: ${environment}`,
        `- **Released artifact(s)**: ${
          artifacts.length > 0
            ? `${artifacts.map((pkg) => `\`${pkg.name}@${version}\` (npm)`).join(", ")}; ${sourceRef}`
            : sourceRef
        }`,
        `- **Component class**: core/infra — every operator field under **Deployment information** applies.`,
        `- **Upgrade scope**: ${todo("binary only, or binary plus a coordinated runtime change")}`,
        `- **Reset required**: ${todo("whether the faucet database or wallet state must be wiped or re-synced")}`,
        `- **Governance action required**: ${todo("whether any on-chain proposal or config ratification is needed")}`,
      ].join("\n"),
    ),
    section(
      "High-level summary",
      todo("write 1-3 sentences summarising what matters most in this release"),
    ),
    section(
      "Audience",
      [
        "These release notes are intended for:",
        "",
        "- Shielded Technologies engineering and SRE teams who deploy and operate the faucet.",
        "- Developers and integrators who request test tokens through `@midnightntwrk/faucet-client`.",
        "- Midnight Foundation release coordinators tracking testnet composition.",
      ].join("\n"),
    ),
    section(
      "Dependencies",
      [
        "Hard, component-local incompatibilities:",
        "",
        ...(pins.length > 0
          ? pins.map((pin) => `- Requires \`${pin.name}\` ${pin.version}.`)
          : ["- — none beyond the pins in the Tested-with table."]),
        "",
        "**Downstream impact (cascading effects).** The faucet is a leaf service — nothing in the Midnight",
        "stack depends on it at runtime, so upgrading it cascades nowhere. The one consumer-visible surface",
        "is `@midnightntwrk/faucet-client`, whose codecs track the server's request and response types.",
      ].join("\n"),
    ),
    section(
      "Tested-with versions",
      [
        "Build pins — not QA-verified. Read from the lockfile and the deployment compose files at this ref.",
        "",
        "| Component | Tested-with version |",
        "| --- | --- |",
        ...pins.map((pin) => `| \`${pin.name}\` | \`${pin.version}\` |`),
        ...images.map((image) => `| \`${image.name}\` | \`${image.version}\` |`),
        ...(images.some((image) => !image.agreed)
          ? [
              "",
              `Pins disagree across compose files for ${images
                .filter((image) => !image.agreed)
                .map((image) => `\`${image.name}\``)
                .join(", ")}. The table reports the deployment value; reconcile the compose files.`,
            ]
          : []),
      ].join("\n"),
    ),
    section(
      "Deployment information",
      [
        `- **Upgrade scope**: ${todo("binary only, or binary plus a coordinated runtime change")}`,
        `- **Reset required**: ${todo("whether a state wipe, re-sync, or re-index is needed")}`,
        `- **Governance action required**: ${todo("whether any on-chain proposal or ratification is needed")}`,
        `- **Downtime / coordination**: ${todo("whether the rollout is hot-swappable or needs a coordinated window")}`,
      ].join("\n"),
    ),
    section(
      "What changed",
      [
        `New in ${version} since ${baseline.version}:`,
        "",
        ...(changeLines.length > 0 ? changeLines : ["- No functional change at this ref."]),
        ...(repeatedLines.length > 0
          ? [
              "",
              "Already announced in earlier pre-releases of this version, repeated only because this is the",
              "current head of the line — not new work:",
              "",
              ...repeatedLines,
            ]
          : []),
      ].join("\n"),
    ),
    section(
      "New features",
      fresh(take("features")).length > 0
        ? fresh(take("features"))
            .map((pr) => `### Feature \`${pr.title}\`\n\n**Description**: see PR #${pr.number}.`)
            .join("\n\n")
        : "None introduced at this ref.",
    ),
    section(
      "New features requiring configuration updates",
      "None at this ref. Configuration-affecting changes are called out under What changed.",
    ),
    section(
      "Improvements",
      fresh(take("improvements")).length > 0 || ids.length > 0
        ? [
            ...fresh(take("improvements")).map(
              (pr) => `**Improvement**: \`${pr.title}\`\n\n**Description**: see PR #${pr.number}.`,
            ),
            ...(ids.length > 0
              ? [
                  `**Improvement**: \`security fixes\`\n\n**Description**: this range carries ${ids.join(
                    ", ",
                  )} (${prs
                    .filter((pr) => securityIds([pr]).length > 0)
                    .map((pr) => `PR #${pr.number}`)
                    .join(", ")}).`,
                ]
              : []),
          ].join("\n\n")
        : "None.",
    ),
    section("Deprecations", "None."),
    section(
      "Breaking changes",
      fresh(take("breaking")).length > 0
        ? fresh(take("breaking"))
            .map(
              (pr) =>
                `### Breaking change \`${pr.title}\`\n\n**What changed**: see PR #${pr.number}.\n\n**Required actions**: ${todo("list the migration steps")}`,
            )
            .join("\n\n")
        : "None.",
    ),
    section(
      "Known issues",
      todo("confirm None, or name each shipped-with problem and its workaround"),
    ),
    section(
      "Links and references",
      [
        `- **QA test coverage / test evidence**: ${todo("link the QA evidence, or state that QA has not run")}`,
        `- **PRs**: [${baseline.tag}...${head} compare](https://github.com/${REPO}/compare/${baseline.tag}...${head})`,
        `- **Engineering docs**: [CONTRIBUTING.md](https://github.com/${REPO}/blob/${head}/CONTRIBUTING.md)`,
        `- **Migration guides**: —`,
        `- **SDK docs**: [docs.midnight.network](https://docs.midnight.network)`,
        `- **Known issues board**: [GitHub issues](https://github.com/${REPO}/issues)`,
        `- **Public schema**: — the faucet publishes no versioned OpenAPI or ABI.`,
        `- **API documentation**: [docs.midnight.network](https://docs.midnight.network)`,
        ``,
        `Repository: [${REPO}](https://github.com/${REPO}).`,
      ].join("\n"),
    ),
    section(
      "Fixed defect list",
      [
        `The following defects were fixed between ${baseline.version} and ${version}.`,
        "",
        "| Defect number | Description |",
        "| --- | --- |",
        ...(take("fixes").length > 0
          ? take("fixes").map((pr) => {
              const issues = closesIssues(pr);
              // Citing the PR again in the description would duplicate the reference when the
              // defect number already is that PR.
              return issues.length > 0
                ? `| #${issues[0]} | ${pr.title} (PR #${pr.number}). |`
                : `| PR #${pr.number} | ${pr.title}. |`;
            })
          : ["| — | No defect was fixed in this range. |"]),
      ].join("\n"),
    ),
  ].join("\n");

  return { body, prs, ids };
};

const { body, prs, ids } = generate();
const outputPath = join(ROOT_DIR, "RELEASE_NOTES.md");
writeFileSync(outputPath, body);

const todoCount = (body.match(/TODO:/g) ?? []).length;

console.log(`Release notes generated: ${outputPath}`);
console.log(`Sourced ${prs.length} merged PR(s) in range.`);
if (ids.length > 0) console.log(`Security identifiers carried: ${ids.join(", ")}`);
if (todoCount > 0) console.log(`${todoCount} field(s) marked TODO for the owner to complete.`);
