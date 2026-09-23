import { describe, expect, it, afterEach, beforeEach } from "vitest";

import { normalizeConfig, type RuntimeConfig } from "../src/runtime-config.js";
import { CorpusStore } from "../src/corpus/store.js";
import { listDocs } from "../src/tools/handlers.js";
import {
  concept,
  createFixtureCorpus,
  standardCorpus,
  type FixtureCorpus,
} from "./fixtures/corpus.js";

const store = new CorpusStore();

let fixture: FixtureCorpus;
let config: RuntimeConfig;

beforeEach(async () => {
  fixture = await standardCorpus();
  config = normalizeConfig({ enabled: true, corpusRoot: fixture.root });
});

afterEach(async () => {
  await fixture.cleanup();
});

function dataOf(outcome: { data?: unknown }): Record<string, unknown> {
  return (outcome.data ?? {}) as Record<string, unknown>;
}

describe("list_docs — progressive disclosure", () => {
  it("lists the bundles when the corpus root has no index.md", async () => {
    const outcome = await listDocs(store, config, {});
    expect(outcome.error).toBeUndefined();
    const data = dataOf(outcome);
    expect(data["kind"]).toBe("listing");
    const directories = data["directories"] as Array<{ name: string; conceptCount: number }>;
    expect(directories.map((entry) => entry.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(directories.find((entry) => entry.name === "alpha")?.conceptCount).toBe(9);
  });

  it("returns the root index.md when there is one", async () => {
    const withIndex = await createFixtureCorpus({
      "index.md": concept({ okf_version: "0.1" }, "# All bundles\n\n* [alpha](alpha/index.md)\n"),
      "alpha/page.md": concept({ type: "Guide", title: "A page" }, "# A page\n\nbody\n"),
    });
    try {
      const local = new CorpusStore();
      const outcome = await listDocs(
        local,
        normalizeConfig({ enabled: true, corpusRoot: withIndex.root }),
        {},
      );
      const data = dataOf(outcome);
      expect(data["kind"]).toBe("index");
      expect(data["concept_id"]).toBe("index.md");
      expect(outcome.content).toContain("All bundles");
    } finally {
      await withIndex.cleanup();
    }
  });

  it("returns a directory's index.md instead of synthesising", async () => {
    const outcome = await listDocs(store, config, { bundle: "alpha" });
    const data = dataOf(outcome);
    expect(data["kind"]).toBe("index");
    expect(data["concept_id"]).toBe("alpha/index.md");
    expect(outcome.content).toContain("Subdirectories");
  });

  it("synthesises a listing when a directory has no index.md", async () => {
    const outcome = await listDocs(store, config, { bundle: "gamma" });
    const data = dataOf(outcome);
    expect(data["kind"]).toBe("listing");
    const directories = data["directories"] as Array<{
      name: string;
      conceptId: string;
      conceptCount: number;
    }>;
    const pages = data["pages"] as Array<{ conceptId: string; title: string }>;

    expect(directories.map((entry) => entry.name)).toEqual(["deep"]);
    expect(directories[0]?.conceptCount).toBe(1);
    expect(pages.map((entry) => entry.conceptId)).toEqual(["gamma/config.md"]);
    expect(pages[0]?.title).toBe("Gamma configuration");
    expect(outcome.content).toContain("Gamma configuration");
  });

  it("accepts a path without a bundle and splits it", async () => {
    const outcome = await listDocs(store, config, { path: "gamma/deep" });
    const data = dataOf(outcome);
    expect(data["kind"]).toBe("listing");
    const pages = data["pages"] as Array<{ conceptId: string }>;
    expect(pages.map((entry) => entry.conceptId)).toEqual(["gamma/deep/page.md"]);
  });

  it("opens an explicit .md path as a document", async () => {
    const outcome = await listDocs(store, config, { bundle: "alpha", path: "install.md" });
    const data = dataOf(outcome);
    expect(data["kind"]).toBe("document");
    expect(outcome.content).toContain("Installing Alpha");
  });

  it("never lists a non-markdown file", async () => {
    const outcome = await listDocs(store, config, { bundle: "gamma" });
    expect(outcome.content).not.toContain("notes.txt");
  });
});

describe("list_docs — refusals and misses are results", () => {
  it("refuses a path that escapes the corpus", async () => {
    const outcome = await listDocs(store, config, { path: "../etc" });
    expect(outcome.error).toMatch(/Refused/);
  });

  it("refuses an absolute path", async () => {
    const outcome = await listDocs(store, config, { path: "/etc" });
    expect(outcome.error).toMatch(/Refused/);
  });

  it("names a bundle that does not exist", async () => {
    const outcome = await listDocs(store, config, { bundle: "nope" });
    expect(outcome.error).toBeUndefined();
    expect(dataOf(outcome)["note"]).toMatch(/no bundle named/i);
  });

  it("names a directory that does not exist", async () => {
    const outcome = await listDocs(store, config, { bundle: "gamma", path: "missing" });
    expect(dataOf(outcome)["note"]).toMatch(/no directory exists/i);
  });

  it("respects the bundle allowlist", async () => {
    const restricted = normalizeConfig({
      enabled: true,
      corpusRoot: fixture.root,
      allowedBundles: ["alpha"],
    });
    const allowed = await listDocs(store, restricted, { bundle: "alpha" });
    expect(allowed.error).toBeUndefined();
    expect(allowed.content).toContain("Subdirectories");

    const refused = await listDocs(store, restricted, { bundle: "gamma" });
    expect(refused.error).toBeUndefined();
    expect(dataOf(refused)["note"]).toMatch(/allowedBundles/);
  });
});
