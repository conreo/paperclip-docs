import { describe, expect, it, afterEach, beforeEach } from "vitest";

import { normalizeConfig, type RuntimeConfig } from "../src/runtime-config.js";
import { CorpusStore } from "../src/corpus/store.js";
import { sources } from "../src/tools/handlers.js";
import {
  concept,
  createFixtureCorpus,
  standardCorpus,
  type FixtureCorpus,
} from "./fixtures/corpus.js";

const store = new CorpusStore();

describe("sources reports the snapshot's age", () => {
  let fixture: FixtureCorpus;
  let config: RuntimeConfig;

  beforeEach(async () => {
    fixture = await standardCorpus();
    config = normalizeConfig({ enabled: true, corpusRoot: fixture.root, allowedBundles: ["alpha", "beta", "gamma"] });
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("finds the oldest and newest timestamps in frontmatter", async () => {
    const outcome = await sources(store, config, {
      now: Date.parse("2026-03-02T00:00:00Z"),
    });
    const data = outcome.data as {
      oldestTimestamp: string;
      newestTimestamp: string;
      ageDays: number;
      stale: boolean;
      totalConcepts: number;
    };

    expect(data.oldestTimestamp).toBe("2020-01-01T00:00:00Z");
    expect(data.newestTimestamp).toBe("2026-03-01T00:00:00Z");
    expect(data.ageDays).toBe(1);
    expect(data.stale).toBe(false);
  });

  it("counts every concept, including the malformed ones", async () => {
    const outcome = await sources(store, config, { now: Date.parse("2026-03-02T00:00:00Z") });
    const data = outcome.data as {
      totalConcepts: number;
      bundles: Array<{ name: string; conceptCount: number }>;
    };
    // alpha: 9, beta: 3, gamma: 2. `gamma/notes.txt` is not markdown.
    expect(data.totalConcepts).toBe(14);
    expect(data.bundles).toEqual([
      { name: "alpha", conceptCount: 9, oldestTimestamp: "2026-01-01T00:00:00Z", newestTimestamp: "2026-03-01T00:00:00Z" },
      { name: "beta", conceptCount: 3, oldestTimestamp: "2020-01-01T00:00:00Z", newestTimestamp: "2021-06-01T00:00:00Z" },
      { name: "gamma", conceptCount: 2, oldestTimestamp: "2025-01-01T00:00:00Z", newestTimestamp: "2025-02-01T00:00:00Z" },
    ]);
  });

  it("flags a corpus older than the warning threshold", async () => {
    // 200 days after the newest capture.
    const outcome = await sources(store, config, {
      now: Date.parse("2026-03-01T00:00:00Z") + 200 * 86_400_000,
    });
    const data = outcome.data as { stale: boolean; ageDays: number };
    expect(data.ageDays).toBe(200);
    expect(data.stale).toBe(true);
    expect(outcome.content).toContain("STALE");
  });

  it("does not flag a corpus exactly at the threshold", async () => {
    // "more than 90 days" is the rule; exactly 90 is not more.
    const outcome = await sources(store, config, {
      now: Date.parse("2026-03-01T00:00:00Z") + 90 * 86_400_000,
    });
    const data = outcome.data as { stale: boolean; ageDays: number };
    expect(data.ageDays).toBe(90);
    expect(data.stale).toBe(false);
  });

  it("says the age is unknown when no timestamp parses", async () => {
    const noDates = await createFixtureCorpus({
      "x/page.md": concept({ type: "Guide", title: "Undated" }, "# Undated\n\nbody\n"),
    });
    try {
      const local = new CorpusStore();
      const outcome = await sources(
        local,
        normalizeConfig({ enabled: true, corpusRoot: noDates.root }),
      );
      const data = outcome.data as { ageDays: number | null; oldestTimestamp: null };
      expect(data.ageDays).toBeNull();
      expect(data.oldestTimestamp).toBeNull();
      expect(outcome.content).toContain("unknown");
    } finally {
      await noDates.cleanup();
    }
  });
});

describe("sources reports a broken corpus instead of throwing", () => {
  it("returns available:false with the reason when the root is missing", async () => {
    const local = new CorpusStore();
    const config = normalizeConfig({
      enabled: true,
      corpusRoot: "/definitely/not/a/corpus",
    });
    const outcome = await sources(local, config);
    const data = outcome.data as { available: boolean };
    expect(data.available).toBe(false);
    expect(outcome.content).toContain("unavailable");
  });
});

describe("sources reports a build manifest when one exists", () => {
  it("includes manifest.json when the builder wrote one", async () => {
    const fixture = await createFixtureCorpus({
      "x/page.md": concept(
        { type: "Guide", title: "Page", timestamp: "2026-01-01T00:00:00Z" },
        "# Page\n\nbody\n",
      ),
      "manifest.json": JSON.stringify({ generator: "build_okf.py", version: "0.1" }),
    });
    try {
      const local = new CorpusStore();
      const outcome = await sources(
        local,
        normalizeConfig({ enabled: true, corpusRoot: fixture.root, allowedBundles: ["alpha", "beta", "gamma"] }),
      );
      const data = outcome.data as {
        manifest: Record<string, unknown> | null;
        manifestPath?: string | null;
        corpusRoot?: string;
      };
      // The contents are provenance an agent can legitimately use; the *path* names a
      // directory on the host, and that directory holds the index and the runner's
      // request folder. Nothing agent-facing reports either path any more.
      expect(data.manifest).toEqual({ generator: "build_okf.py", version: "0.1" });
      expect(data.manifestPath).toBeUndefined();
      expect(data.corpusRoot).toBeUndefined();
      expect(outcome.content).not.toContain("Corpus root:");
      expect(outcome.content).not.toContain(fixture.root);
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports an unparseable manifest without failing the tool", async () => {
    const fixture = await createFixtureCorpus({
      "x/page.md": concept({ type: "Guide", title: "Page" }, "# Page\n\nbody\n"),
      "manifest.json": "{ not json",
    });
    try {
      const local = new CorpusStore();
      const status = await local.describe(fixture.root);
      expect(status.exists).toBe(true);
      expect(status.manifest).toBeNull();
      expect(status.error).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });
});
