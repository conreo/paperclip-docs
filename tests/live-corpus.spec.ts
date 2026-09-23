/**
 * The real corpus, end to end.
 *
 * The rest of the suite runs against small fixtures, which pins the *logic* but
 * would pass unchanged on a corpus of three files. This file runs the four tools
 * against the actual OKF bundles on this machine — ~80 MB, five figures of
 * concepts — so the things that only appear at that size are exercised:
 * indexing time, a document that needs truncating, and a search whose correct
 * answer is one bundle among a dozen unrelated products.
 *
 * It skips rather than fails when the corpus is absent, because a missing corpus
 * is a deployment fact, not a defect — the same rule the CodeGraph plugin uses
 * for its live git tests.
 *
 * Point it elsewhere with `PAPERCLIP_DOCS_TEST_CORPUS=/path/to/okf-bundles`.
 */

import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CorpusStore } from "../src/corpus/store.js";
import { normalizeConfig, type RuntimeConfig } from "../src/runtime-config.js";
import { listDocs, readDoc, searchDocs, sources, type ToolOutcome } from "../src/tools/handlers.js";

const CORPUS_ROOT =
  process.env["PAPERCLIP_DOCS_TEST_CORPUS"] ??
  path.join(os.homedir(), "offline-docs", "okf-bundles");

const present = fs.existsSync(path.join(CORPUS_ROOT, "index.md")) || fs.existsSync(CORPUS_ROOT);

const store = new CorpusStore();
let config: RuntimeConfig;

/** The handlers return a human-readable `content` plus structured `data`. */
function dataOf(outcome: ToolOutcome): Record<string, unknown> {
  expect(outcome.error, `tool returned an error: ${String(outcome.error)}`).toBeUndefined();
  return (outcome.data ?? {}) as Record<string, unknown>;
}

describe.skipIf(!present)("the installed corpus, end to end", () => {
  beforeAll(() => {
    config = normalizeConfig({ enabled: true, corpusRoot: CORPUS_ROOT });
  });

  it("indexes every bundle on disk and reports a plausible size", async () => {
    const index = await store.load(CORPUS_ROOT);

    // Bounds, not exact counts: the corpus is refreshed, and a test that has to be
    // edited on every refresh stops being run.
    expect(index.bundles.length).toBeGreaterThanOrEqual(10);
    // A floor, not a snapshot. It used to be 5,000 because that was one build of
    // one corpus; the builder now excludes changelogs, contributor guides and
    // translations on purpose, so the same sources legitimately produce fewer
    // concepts. What is worth asserting is that this is a real corpus and not a
    // fixture — the fixture corpora in this repo are tens of pages, so an order of
    // magnitude above them is the property that matters.
    expect(index.concepts.length).toBeGreaterThan(1_000);
    // Every concept knows which bundle it came from, or `bundle` filtering is a
    // lie for the ones that do not. The corpus has exactly one exception: its own
    // master `index.md` at the root, which is navigation rather than documentation
    // and carries no frontmatter. Asserting the exception rather than skipping it
    // means it cannot quietly grow into "some concepts have no bundle".
    for (const concept of index.concepts) {
      if (!concept.conceptId.includes("/")) {
        expect(concept.bundle).toBe("");
        expect(concept.conceptId).toBe("index.md");
      } else {
        expect(concept.bundle.length).toBeGreaterThan(0);
      }
      expect(concept.conceptId.endsWith(".md")).toBe(true);
    }
  });

  it("serves a second load from cache", async () => {
    await store.load(CORPUS_ROOT);
    const started = Date.now();
    await store.load(CORPUS_ROOT);
    // The corpus is read once and then reused. Re-reading 80 MB per call would
    // make every tool call unusable, so this is a correctness assertion, not a
    // performance one.
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("reports its own age, so an answer can be qualified", async () => {
    const data = dataOf(await sources(store, config, {}));
    const newest = Date.parse(String(data["newestTimestamp"]));
    expect(Number.isFinite(newest)).toBe(true);
    expect(typeof data["ageDays"]).toBe("number");
    // The timestamps are the point: a snapshot that cannot say how old it is
    // presents stale vendor documentation as current.
    expect(Number(data["ageDays"])).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(data["bundles"])).toBe(true);
  });

  it("finds a product-specific answer inside the right bundle", async () => {
    const data = dataOf(
      await searchDocs(store, config, { query: "grafana dashboard provisioning", limit: 5 }),
    );
    const results = data["results"] as Array<{ bundle: string; conceptId: string }>;
    expect(results.length).toBeGreaterThan(0);
    // A query naming one product must not be answered out of another. With a dozen
    // unrelated products in one index that is the failure worth guarding.
    expect(results.some((hit) => hit.bundle === "grafana")).toBe(true);
  });

  it("honours a bundle filter", async () => {
    const data = dataOf(await searchDocs(store, config, { query: "node", bundle: "n8n", limit: 5 }));
    const results = data["results"] as Array<{ bundle: string }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((hit) => hit.bundle === "n8n")).toBe(true);
  });

  it("lists the corpus from the root", async () => {
    const data = dataOf(await listDocs(store, config, {}));
    // The real corpus ships a master `index.md` at the root, so the root answers
    // with that index *document* rather than a synthesized directory listing.
    // Both are legitimate progressive disclosure, and which one appears is a
    // property of the corpus, not of the tool — so assert the invariant: the
    // caller gets something to navigate by.
    const kind = data["kind"];
    expect(["index", "document", "listing"]).toContain(kind);
    const body = String(data["body"] ?? "");
    const directories = (data["directories"] ?? []) as unknown[];
    const pages = (data["pages"] ?? []) as unknown[];
    expect(body.length + directories.length + pages.length).toBeGreaterThan(0);
  });

  it("lists a single bundle's contents", async () => {
    // Named bundle, so this exercises the directory path even when the root has an
    // index.md of its own.
    const data = dataOf(await listDocs(store, config, { bundle: "n8n" }));
    const body = String(data["body"] ?? "");
    const directories = (data["directories"] ?? []) as unknown[];
    const pages = (data["pages"] ?? []) as unknown[];
    expect(body.length + directories.length + pages.length).toBeGreaterThan(0);
  });

  it("reads a real document with its frontmatter", async () => {
    const index = await store.load(CORPUS_ROOT);
    // `bodyPreview` is capped, so it is only a proxy for size — any concept with a
    // substantial preview is a real page.
    const target = index.concepts.find((concept) => concept.bodyPreview.length > 500);
    expect(target, "no document large enough to read in the corpus").toBeTruthy();

    const data = dataOf(await readDoc(store, config, { concept_id: target!.conceptId }));
    expect(String(data["body"]).length).toBeGreaterThan(0);
    expect(data["concept_id"]).toBe(target!.conceptId);
    expect(typeof data["frontmatter"]).toBe("object");
  });

  it("refuses to read outside the corpus, on the real tree", async () => {
    // The fixture test proves the rule; this proves the rule is wired to the
    // handler the agent actually reaches.
    for (const attempt of ["../etc/passwd", "/etc/passwd", "n8n/../../etc/passwd"]) {
      const outcome = await readDoc(store, config, { concept_id: attempt });
      expect(outcome.error ?? "", `"${attempt}" was not refused`).not.toBe("");
    }
  });

  it("returns a clean not-found rather than throwing", async () => {
    const outcome = await readDoc(store, config, {
      concept_id: "definitely-not-a-bundle/nope.md",
    });
    expect(outcome.error).toBeTruthy();
    expect(String(outcome.error)).not.toContain("ENOENT");
  });
});
