import { describe, expect, it } from "vitest";

import {
  displayTitle,
  extractHeadings,
  firstHeading,
  normalizeTags,
  normalizeTimestamp,
  parseFrontmatter,
} from "../src/corpus/frontmatter.js";
import { concept } from "./fixtures/corpus.js";

describe("parseFrontmatter — well-formed concepts", () => {
  it("reads the OKF fields the build emits", () => {
    const parsed = parseFrontmatter(
      concept(
        {
          okf_version: "0.1",
          type: "Guide",
          title: "Transfer Ownership",
          description: "- Files & synchronization",
          resource: "https://docs.nextcloud.com/x",
          tags: ["nextcloud"],
          timestamp: "2026-07-03T02:22:34Z",
        },
        "# Transfer Ownership\n\nBody text.\n",
      ),
    );

    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.error).toBeNull();
    expect(parsed.frontmatter["type"]).toBe("Guide");
    expect(parsed.frontmatter["title"]).toBe("Transfer Ownership");
    expect(parsed.frontmatter["resource"]).toBe("https://docs.nextcloud.com/x");
    expect(parsed.frontmatter["tags"]).toEqual(["nextcloud"]);
    expect(parsed.frontmatter["timestamp"]).toBe("2026-07-03T02:22:34Z");
    expect(parsed.body).toContain("# Transfer Ownership");
  });

  it("tolerates the leading blank line and CRLF endings the real files carry", () => {
    const raw = '\r\n\r\n---\r\n\r\ntype: Guide\r\ntitle: "X"\r\n\r\n---\r\n\r\nBody.\r\n';
    const parsed = parseFrontmatter(raw);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter["title"]).toBe("X");
    expect(parsed.body).toBe("Body.\r\n".replace(/\r\n/g, "\n"));
  });

  it("parses a block sequence for tags", () => {
    const raw = ["---", "tags:", "  - alpha", "  - beta", "---", "", "body"].join("\n");
    const parsed = parseFrontmatter(raw);
    expect(parsed.frontmatter["tags"]).toEqual(["alpha", "beta"]);
    expect(parsed.error).toBeNull();
  });

  it("keeps a URL containing `#` intact", () => {
    const parsed = parseFrontmatter(
      concept({ resource: "https://example.test/page#section" }, "body"),
    );
    expect(parsed.frontmatter["resource"]).toBe("https://example.test/page#section");
  });
});

describe("parseFrontmatter — the malformed shapes", () => {
  it("treats a file with no frontmatter as all body", () => {
    const raw = "# Bare page\n\nNo frontmatter here.\n";
    const parsed = parseFrontmatter(raw);
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.error).toBeNull();
    expect(parsed.body).toBe(raw);
  });

  it("records malformed YAML but keeps the fields that parsed and the body", () => {
    const raw = [
      "---",
      'title: "unterminated',
      "type: Guide",
      "tags: [alpha]",
      "---",
      "",
      "# Still readable",
    ].join("\n");
    const parsed = parseFrontmatter(raw);

    expect(parsed.error).toMatch(/unterminated double-quoted/i);
    // The point of degrading rather than throwing: the good fields survive.
    expect(parsed.frontmatter["type"]).toBe("Guide");
    expect(parsed.frontmatter["tags"]).toEqual(["alpha"]);
    expect(parsed.body).toContain("# Still readable");
  });

  it("records an unterminated flow sequence", () => {
    const parsed = parseFrontmatter(["---", "tags: [alpha, beta", "---", "", "body"].join("\n"));
    expect(parsed.error).toMatch(/unterminated flow sequence/i);
  });

  it("records an unclosed frontmatter block rather than swallowing the file", () => {
    const parsed = parseFrontmatter("---\ntype: Guide\n\nbody without a closing delimiter\n");
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.error).toMatch(/never closed/i);
    expect(parsed.body).toContain("body without a closing delimiter");
  });

  it("records an unsupported nested line once and keeps going", () => {
    const raw = ["---", "title: X", "nested:", "  inner: 1", "type: Guide", "---", "", "b"].join("\n");
    const parsed = parseFrontmatter(raw);
    expect(parsed.error).toMatch(/unsupported frontmatter syntax/i);
    expect(parsed.frontmatter["title"]).toBe("X");
    expect(parsed.frontmatter["type"]).toBe("Guide");
  });
});

describe("normalizeTags", () => {
  it("accepts a list of strings", () => {
    expect(normalizeTags(["alpha", "setup"])).toEqual(["alpha", "setup"]);
  });

  it("accepts a single string as a one-element list", () => {
    expect(normalizeTags("alpha")).toEqual(["alpha"]);
  });

  it("splits a comma-separated string", () => {
    expect(normalizeTags("alpha, setup , beta")).toEqual(["alpha", "setup", "beta"]);
  });

  it("drops non-string entries instead of failing the document", () => {
    expect(normalizeTags(["alpha", 7, null, "setup"])).toEqual(["alpha", "setup"]);
  });

  it("returns an empty list for anything else", () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(42)).toEqual([]);
    expect(normalizeTags({})).toEqual([]);
  });
});

describe("normalizeTimestamp", () => {
  it("keeps a parseable timestamp", () => {
    expect(normalizeTimestamp("2026-07-03T02:22:31Z")).toBe("2026-07-03T02:22:31Z");
  });

  it("refuses a garbled timestamp rather than making the corpus look fresh", () => {
    expect(normalizeTimestamp("last tuesday")).toBeNull();
    expect(normalizeTimestamp("")).toBeNull();
    expect(normalizeTimestamp(42)).toBeNull();
  });
});

describe("headings and titles", () => {
  it("extracts headings in order and respects the cap", () => {
    const body = "# One\n\ntext\n\n## Two\n\n### Three\n";
    expect(extractHeadings(body, 10)).toEqual(["One", "Two", "Three"]);
    expect(extractHeadings(body, 2)).toEqual(["One", "Two"]);
  });

  it("finds the first heading", () => {
    expect(firstHeading("\n\n## Sub\n\nbody")).toBe("Sub");
    expect(firstHeading("no headings here")).toBeNull();
  });

  it("prefers the frontmatter title", () => {
    expect(displayTitle("Real Title", "# Heading", "a/b.md")).toBe("Real Title");
  });

  it("treats `Untitled` as absent and falls back to the first heading", () => {
    expect(displayTitle("Untitled", "# Actual Heading", "a/b.md")).toBe("Actual Heading");
  });

  it("falls back to the filename when there is neither", () => {
    expect(displayTitle(undefined, "body only", "n8n/transfer_ownership.md")).toBe(
      "transfer ownership",
    );
  });
});
