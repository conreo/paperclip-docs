/**
 * Fixture corpora for the tests.
 *
 * Every test builds its own small corpus in the OS temp directory rather than
 * reading `the offline-docs corpus on the developer's machine`. That directory is a build artifact on one
 * machine: a test that depended on it would pass on the machine that built the
 * corpus and fail everywhere else, including CI, and it would silently start
 * asserting different things the next time the corpus was rebuilt.
 *
 * The fixture below is deliberately *not* just the happy path. It contains the
 * four malformed shapes the parser must survive (broken YAML, no frontmatter,
 * tags as a string, empty body), a bundle with no `index.md` so the synthesised
 * listing path is exercised, and two concepts whose only shared term appears in
 * one title and one body so field weighting can be asserted.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FixtureCorpus {
  root: string;
  cleanup: () => Promise<void>;
}

/** Write a set of files (relative posix path → content) into a fresh temp dir. */
export async function createFixtureCorpus(
  files: Record<string, string>,
): Promise<FixtureCorpus> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "paperclip-docs-"));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
    await fs.promises.writeFile(absolute, content, "utf8");
  }
  return {
    root,
    cleanup: async () => {
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

function renderScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Serialise a frontmatter field value the way the Python build does. */
export function renderValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(renderScalar).join(", ")}]`;
  return renderScalar(value);
}

/** Compose a well-formed OKF concept file. */
export function concept(fields: Record<string, unknown>, body: string): string {
  const lines: string[] = ["---", ""];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${renderValue(value)}`);
  }
  lines.push("", "---", "", body);
  return lines.join("\n");
}

/**
 * The shared corpus most tests use.
 *
 * Bundle `gamma` deliberately has no `index.md` at its root, so `list_docs`
 * falls through to the synthesised-listing branch. Bundle `alpha` has one, so
 * the index branch is exercised too.
 */
export function standardCorpusFiles(): Record<string, string> {
  return {
    // -- alpha: the well-formed bundle, with an index.md --------------------
    "alpha/index.md": concept(
      { okf_version: "0.1" },
      "# Subdirectories\n\n* [alpha](alpha/index.md)\n",
    ),
    "alpha/install.md": concept(
      {
        type: "Guide",
        title: "Installing Alpha",
        description: "How to install Alpha on a server",
        resource: "https://example.test/alpha/install",
        tags: ["alpha", "setup"],
        timestamp: "2026-01-01T00:00:00Z",
        okf_version: "0.1",
      },
      [
        "# Installing Alpha",
        "",
        "Alpha is installed with the package manager.",
        "",
        "## Prerequisites",
        "",
        "A supported operating system and network access.",
        "",
        "## Steps",
        "",
        "Run the installer, then restart the service.",
      ].join("\n"),
    ),
    "alpha/webhooks.md": concept(
      {
        type: "Reference",
        title: "Webhook delivery",
        description: "Outbound webhooks and their retries",
        resource: "https://example.test/alpha/webhooks",
        tags: ["alpha"],
        timestamp: "2026-03-01T00:00:00Z",
        okf_version: "0.1",
      },
      [
        "# Webhook delivery",
        "",
        "A webhook is delivered over HTTPS and retried on failure.",
        "",
        "## Retry policy",
        "",
        "Failed webhooks are retried with exponential backoff.",
      ].join("\n"),
    ),
    "alpha/zebra-title.md": concept(
      {
        type: "Guide",
        title: "Zebra handling",
        description: "How Alpha handles zebras",
        tags: ["alpha"],
        timestamp: "2026-02-01T00:00:00Z",
        okf_version: "0.1",
      },
      "# Zebra handling\n\nNothing else of note on this page.\n",
    ),
    // Longer than the minimum document cap, so truncation has something to cut.
    "alpha/long.md": concept(
      {
        type: "Guide",
        title: "Long page",
        description: "A page longer than the test cap",
        tags: ["alpha"],
        timestamp: "2026-02-15T00:00:00Z",
        okf_version: "0.1",
      },
      `# Long page\n\n${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(80)}`,
    ),

    // -- the malformed shapes ----------------------------------------------
    // An unterminated double quote: the parser must record the error, keep the
    // fields it did parse, and still return the body.
    "alpha/broken.md": [
      "---",
      "",
      'title: "unterminated',
      "type: Guide",
      "tags: [alpha]",
      "",
      "---",
      "",
      "# Broken frontmatter",
      "",
      "The body is still readable even though the YAML is not.",
    ].join("\n"),
    // No frontmatter at all — the whole file is body. Real `index.md` files look
    // like this.
    "alpha/no-frontmatter.md": [
      "# Bare page",
      "",
      "This concept has no frontmatter whatsoever.",
    ].join("\n"),
    // `tags` as a string rather than a list.
    "alpha/string-tags.md": concept(
      { type: "Guide", title: "String tags", tags: "alpha, setup", okf_version: "0.1" },
      "# String tags\n\nA page whose tags are a single string.\n",
    ),
    // An empty body is a valid concept.
    "alpha/empty-body.md": concept(
      { type: "Guide", title: "Empty body", tags: ["alpha"], okf_version: "0.1" },
      "",
    ),

    // -- beta: older, and the body-only match for "zebra" -------------------
    "beta/index.md": concept({ okf_version: "0.1" }, "# Pages\n\n* [Troubleshooting](troubleshooting.md)\n"),
    "beta/zebra-body.md": concept(
      {
        type: "Concept",
        title: "Unrelated page",
        description: "A page whose only mention is in the body",
        tags: ["beta"],
        timestamp: "2021-06-01T00:00:00Z",
        okf_version: "0.1",
      },
      "# Unrelated page\n\nThis page mentions zebra once, in the body, and nowhere else.\n",
    ),
    "beta/troubleshooting.md": concept(
      {
        type: "Guide",
        title: "Troubleshooting Beta",
        description: "Common Beta problems",
        tags: ["beta"],
        timestamp: "2020-01-01T00:00:00Z",
        okf_version: "0.1",
      },
      "# Troubleshooting Beta\n\nIf Beta will not start, check the log.\n",
    ),

    // -- gamma: no index.md anywhere, so listings are synthesised -----------
    "gamma/config.md": concept(
      {
        type: "Configuration",
        title: "Gamma configuration",
        description: "All Gamma settings",
        tags: ["gamma"],
        timestamp: "2025-01-01T00:00:00Z",
        okf_version: "0.1",
      },
      "# Gamma configuration\n\nEvery setting Gamma understands, including zebra mode.\n",
    ),
    "gamma/deep/page.md": concept(
      {
        type: "Guide",
        title: "Deep Gamma page",
        description: "A page two levels down",
        tags: ["gamma"],
        timestamp: "2025-02-01T00:00:00Z",
        okf_version: "0.1",
      },
      "# Deep Gamma page\n\nNested content.\n",
    ),
    // A non-markdown file must be ignored by the walk.
    "gamma/notes.txt": "not a concept\n",
  };
}

/** Build the shared corpus in a temp directory. */
export async function standardCorpus(): Promise<FixtureCorpus> {
  return createFixtureCorpus(standardCorpusFiles());
}
