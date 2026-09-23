import { describe, expect, it, afterEach, beforeEach } from "vitest";

import { truncationMarker } from "../src/constants.js";
import { normalizeConfig, type RuntimeConfig } from "../src/runtime-config.js";
import { readConcept, CorpusStore } from "../src/corpus/store.js";
import { readDoc } from "../src/tools/handlers.js";
import { standardCorpus, type FixtureCorpus } from "./fixtures/corpus.js";

/**
 * `read_doc` is the tool that can damage a conversation.
 *
 * An unbounded tool result does not fail; it silently evicts whatever the agent
 * was holding, which is why the cap exists and why the truncation is *stated in
 * the text* rather than applied quietly. The cap is 500 here — the schema's
 * minimum — so a short fixture still crosses it.
 */

const CAP = 500;

let fixture: FixtureCorpus;
let config: RuntimeConfig;

beforeEach(async () => {
  fixture = await standardCorpus();
  config = normalizeConfig({ enabled: true, corpusRoot: fixture.root, allowedBundles: ["alpha", "beta", "gamma"], maxDocChars: CAP });
});

afterEach(async () => {
  await fixture.cleanup();
});

const store = new CorpusStore();

describe("read_doc truncation", () => {
  it("truncates at the cap and marks the cut", async () => {
    const outcome = await readDoc(store, config, { concept_id: "alpha/long.md" });
    expect(outcome.error).toBeUndefined();
    expect(outcome.content).toContain(`[paperclip-docs: truncated at ${CAP} of`);

    const data = outcome.data as { body: string; truncated: boolean; totalChars: number };
    expect(data.truncated).toBe(true);
    expect(data.body).toHaveLength(CAP);
    expect(data.totalChars).toBeGreaterThan(CAP);
  });

  it("emits the exact marker the constants module defines", async () => {
    const outcome = await readDoc(store, config, { concept_id: "alpha/long.md" });
    const data = outcome.data as { totalChars: number };
    expect(outcome.content).toContain(truncationMarker(CAP, data.totalChars));
  });

  it("does not truncate or mark a document under the cap", async () => {
    const roomy = normalizeConfig({ enabled: true, corpusRoot: fixture.root, allowedBundles: ["alpha", "beta", "gamma"], maxDocChars: 40_000 });
    const outcome = await readDoc(store, roomy, { concept_id: "alpha/long.md" });
    expect(outcome.content).not.toContain("truncated at");
    const data = outcome.data as { truncated: boolean };
    expect(data.truncated).toBe(false);
  });

  it("reports the real total length, not the truncated one", async () => {
    const outcome = await readDoc(store, config, { concept_id: "alpha/long.md" });
    const data = outcome.data as { totalChars: number };
    const full = await readConcept(fixture.root, "alpha/long.md", { maxChars: 1_000_000 });
    expect(full.ok).toBe(true);
    if (full.ok) expect(data.totalChars).toBe(full.concept.totalChars);
  });
});

describe("read_doc metadata", () => {
  it("returns frontmatter and the parsed fields", async () => {
    const roomy = normalizeConfig({ enabled: true, corpusRoot: fixture.root, allowedBundles: ["alpha", "beta", "gamma"] });
    const outcome = await readDoc(store, roomy, { concept_id: "alpha/webhooks.md" });
    const data = outcome.data as {
      title: string;
      type: string;
      tags: string[];
      timestamp: string;
      resource: string;
      frontmatter: Record<string, unknown>;
    };
    expect(data.title).toBe("Webhook delivery");
    expect(data.type).toBe("Reference");
    expect(data.tags).toEqual(["alpha"]);
    expect(data.timestamp).toBe("2026-03-01T00:00:00Z");
    expect(data.resource).toBe("https://example.test/alpha/webhooks");
    expect(data.frontmatter["okf_version"]).toBe("0.1");
  });

  it("notes a frontmatter parse failure without failing the read", async () => {
    const roomy = normalizeConfig({ enabled: true, corpusRoot: fixture.root, allowedBundles: ["alpha", "beta", "gamma"] });
    const outcome = await readDoc(store, roomy, { concept_id: "alpha/broken.md" });
    expect(outcome.error).toBeUndefined();
    expect(outcome.content).toContain("did not fully parse");
    expect(outcome.content).toContain("The body is still readable");
  });
});

describe("read_doc failures are results, not exceptions", () => {
  it("returns an error string for a missing concept", async () => {
    const outcome = await readDoc(store, config, { concept_id: "nope/missing.md" });
    // The bundle is refused before its contents are looked at, so this reports the
    // bundle rather than a missing concept — an ungranted bundle should not reveal
    // whether a named concept exists inside it.
    expect(outcome.error).toMatch(/not available/);
    expect(outcome.content).toBeUndefined();
  });

  it("returns an error string for a path that escapes the corpus", async () => {
    // Through a *granted* bundle, so it is the path check that refuses rather than
    // the allowlist: `alpha` is readable, `../../..` is not.
    const outcome = await readDoc(store, config, { concept_id: "alpha/../../../../etc/passwd" });
    expect(outcome.error).toMatch(/Refused/);
  });

  it("returns an error string for an absolute path", async () => {
    const outcome = await readDoc(store, config, { concept_id: "/etc/passwd" });
    // Either refusal is correct here: an absolute concept id names no granted bundle,
    // so the allowlist answers first — and never reaches the filesystem at all.
    expect(outcome.error).toMatch(/Refused|not available/);
  });

  it("returns a clean error when concept_id is missing", async () => {
    const outcome = await readDoc(store, config, {});
    expect(outcome.error).toMatch(/concept_id/);
  });

  it("points at list_docs when the path is a directory", async () => {
    const outcome = await readDoc(store, config, { concept_id: "alpha" });
    expect(outcome.error).toMatch(/list_docs/);
  });
});
