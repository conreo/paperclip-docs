import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SNIPPET_CHARS } from "../src/constants.js";
import { searchConcepts, tokenize } from "../src/corpus/search.js";
import { CorpusStore, type CorpusIndex } from "../src/corpus/store.js";
import { createFixtureCorpus, standardCorpus, type FixtureCorpus } from "./fixtures/corpus.js";

let fixture: FixtureCorpus;
let index: CorpusIndex;
const store = new CorpusStore();

beforeEach(async () => {
  fixture = await standardCorpus();
  index = await store.load(fixture.root);
});

afterEach(async () => {
  store.invalidate();
  await fixture.cleanup();
});

/** A hit by concept id, for readable assertions. */
function find(conceptId: string, query: string, allowedBundles: string[] = []) {
  return searchConcepts(index, query, { limit: 50, allowedBundles }).hits.find(
    (hit) => hit.conceptId === conceptId,
  );
}

describe("tokenize", () => {
  it("lower-cases, dedupes and drops single characters", () => {
    expect(tokenize("Webhook, WEBHOOK a delivery")).toEqual(["webhook", "delivery"]);
  });

  it("keeps digits so product names survive", () => {
    expect(tokenize("n8n")).toEqual(["n8n"]);
  });

  it("returns nothing for punctuation alone", () => {
    expect(tokenize("!!! ???")).toEqual([]);
  });
});

describe("field weighting", () => {
  it("ranks a title match above a body-only match", () => {
    const outcome = searchConcepts(index, "zebra", { limit: 10, allowedBundles: [] });
    const titleHit = outcome.hits.find((hit) => hit.conceptId === "alpha/zebra-title.md");
    const bodyHit = outcome.hits.find((hit) => hit.conceptId === "beta/zebra-body.md");

    expect(titleHit, "the title match should be present").toBeDefined();
    expect(bodyHit, "the body-only match should be present").toBeDefined();
    expect(titleHit!.score).toBeGreaterThan(bodyHit!.score);
    // And the ordering the score implies, not just the number.
    expect(outcome.hits[0]!.conceptId).toBe("alpha/zebra-title.md");
  });

  it("reports the heading the match landed under", () => {
    const hit = find("alpha/webhooks.md", "retry policy");
    expect(hit?.heading).toBe("Retry policy");
  });
});

describe("AND then OR", () => {
  it("uses ALL when every term matches", () => {
    const outcome = searchConcepts(index, "webhook retry", { limit: 10, allowedBundles: [] });
    expect(outcome.mode).toBe("all");
    expect(outcome.hits.map((hit) => hit.conceptId)).toContain("alpha/webhooks.md");
  });

  it("falls back to ANY and says so when no document has every term", () => {
    const outcome = searchConcepts(index, "webhook nonexistentterm", {
      limit: 10,
      allowedBundles: [],
    });
    expect(outcome.mode).toBe("any");
    expect(outcome.hits.map((hit) => hit.conceptId)).toContain("alpha/webhooks.md");
  });

  it("returns no hits and reports the fallback mode when nothing matches at all", () => {
    const outcome = searchConcepts(index, "qwertyuiop", { limit: 10, allowedBundles: [] });
    // The ANY fallback *was* attempted, so that is the mode reported: the result
    // says "we searched loosely and found nothing", not "an exact search found
    // nothing", which would be a different and more confident claim.
    expect(outcome.mode).toBe("any");
    expect(outcome.hits).toEqual([]);
  });
});

describe("filters and limits", () => {
  it("honours the bundle filter", () => {
    const outcome = searchConcepts(index, "install", { bundle: "beta", limit: 10, allowedBundles: [] });
    expect(outcome.hits.filter((hit) => hit.bundle !== "beta")).toEqual([]);
  });

  it("honours the allowlist", () => {
    const outcome = searchConcepts(index, "zebra", { limit: 10, allowedBundles: ["alpha"] });
    expect(outcome.hits.every((hit) => hit.bundle === "alpha")).toBe(true);
    expect(outcome.hits.map((hit) => hit.conceptId)).not.toContain("beta/zebra-body.md");
  });

  it("honours the type filter case-insensitively", () => {
    const outcome = searchConcepts(index, "alpha", { type: "guide", limit: 50, allowedBundles: [] });
    expect(outcome.hits.length).toBeGreaterThan(0);
    expect(outcome.hits.every((hit) => hit.type === "Guide")).toBe(true);
  });

  it("respects the limit and reports that more exist", () => {
    const outcome = searchConcepts(index, "alpha", { limit: 1, allowedBundles: [] });
    expect(outcome.hits).toHaveLength(1);
    expect(outcome.more).toBe(true);
  });
});

describe("snippets", () => {
  it("bounds every snippet", () => {
    const outcome = searchConcepts(index, "alpha", { limit: 50, allowedBundles: [] });
    for (const hit of outcome.hits) {
      expect(hit.snippet.length).toBeLessThanOrEqual(SNIPPET_CHARS);
    }
  });

  it("returns an empty snippet for an empty body rather than throwing", () => {
    const hit = find("alpha/empty-body.md", "empty body");
    expect(hit).toBeDefined();
    expect(hit!.snippet).toBe("");
  });
});

describe("malformed concepts never fail the search", () => {
  it("still indexes a document whose frontmatter did not parse", () => {
    const outcome = searchConcepts(index, "broken frontmatter", { limit: 10, allowedBundles: [] });
    expect(outcome.hits.map((hit) => hit.conceptId)).toContain("alpha/broken.md");
  });

  it("indexes a document with no frontmatter by its first heading", () => {
    const outcome = searchConcepts(index, "bare page", { limit: 10, allowedBundles: [] });
    const hit = outcome.hits.find((entry) => entry.conceptId === "alpha/no-frontmatter.md");
    expect(hit).toBeDefined();
    expect(hit!.title).toBe("Bare page");
  });

  it("skips an unreadable file but indexes the rest", async () => {
    // A dangling symlink is the portable way to make a `.md` path unreadable
    // without depending on file permissions or on the test not running as root.
    const broken = await createFixtureCorpus({ "ok.md": "# Fine\n\nfine body\n" });
    try {
      fs.symlinkSync(
        path.join(broken.root, "missing-target.md"),
        path.join(broken.root, "dangling.md"),
      );
      const localStore = new CorpusStore();
      const localIndex = await localStore.load(broken.root);
      expect(localIndex.skipped).toBeGreaterThanOrEqual(1);
      expect(localIndex.concepts.map((record) => record.conceptId)).toEqual(["ok.md"]);
    } finally {
      await broken.cleanup();
    }
  });

  it("does not follow a symlink that leaves the corpus", async () => {
    const corpus = await createFixtureCorpus({ "ok.md": "# Fine\n\nfine body\n" });
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "paperclip-docs-outside-"));
    try {
      await fs.promises.writeFile(path.join(outside, "secret.md"), "# Secret\n\nclassified\n", "utf8");
      fs.symlinkSync(outside, path.join(corpus.root, "escape"));
      const localStore = new CorpusStore();
      const localIndex = await localStore.load(corpus.root);
      expect(localIndex.concepts.map((record) => record.conceptId)).toEqual(["ok.md"]);
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
      await corpus.cleanup();
    }
  });
});

describe("index caching", () => {
  it("reuses the index while the corpus signature is unchanged", async () => {
    const first = await store.load(fixture.root);
    const second = await store.load(fixture.root);
    expect(second).toBe(first);
  });

  it("rebuilds when the corpus changes", async () => {
    const first = await store.load(fixture.root);
    // The signature is directory mtimes. The delay makes the mtime difference
    // unambiguous on filesystems with coarse timestamps.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.promises.writeFile(
      path.join(fixture.root, "gamma", "added.md"),
      "# Added\n\nA newly built page about aardvarks.\n",
      "utf8",
    );
    const second = await store.load(fixture.root);
    expect(second.concepts.length).toBe(first.concepts.length + 1);
  });

  it("rebuilds on demand even when the signature has not moved", async () => {
    const first = await store.load(fixture.root);
    const second = await store.load(fixture.root, { force: true });
    expect(second).not.toBe(first);
    expect(second.concepts.length).toBe(first.concepts.length);
  });
});
