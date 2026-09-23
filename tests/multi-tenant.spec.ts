/**
 * Multiple organizations on one worker.
 *
 * This plugin is not per-company in the way the CodeGraph plugin is. There, each
 * company binds its own repositories and isolation follows from *what exists*:
 * a company can only reach its own project workspace. Here the corpus is a shared,
 * instance-wide artifact — the same vendor documentation for everyone — so there
 * is nothing to bind per company and no content that is inherently whose.
 *
 * That makes `allowedBundles` the **only** content control the plugin has, which
 * raises the bar on it: it has to hold on every path that reaches a document, not
 * merely where a bundle is discovered. `search_docs` and `list_docs` filtered;
 * `read_doc` did not, so a company restricted to one bundle could read any other
 * by naming a concept id it was never shown. These tests run the tools through the
 * host harness, on one shared store, the way a single worker process serving two
 * companies does.
 *
 * The same shared cache is the other half of the question: one `CorpusStore` is
 * keyed by root, so two companies on the same corpus share one parsed index —
 * which is correct and is why the filter must be applied per call rather than at
 * load time.
 */

import { describe, expect, it, afterEach } from "vitest";

import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";

import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { createFixtureCorpus, standardCorpus, type FixtureCorpus } from "./fixtures/corpus.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

const setup = plugin.definition.setup as (ctx: unknown) => Promise<void> | void;

interface ToolResultLike {
  content?: string;
  error?: string;
  data?: unknown;
}

describe("two organizations, one worker", () => {
  let fixture: FixtureCorpus;

  afterEach(async () => {
    await fixture?.cleanup();
  });

  async function boot(config: Record<string, unknown>): Promise<TestHarness> {
    const harness = createTestHarness({ manifest, config });
    await setup(harness.ctx);
    return harness;
  }

  async function call(
    harness: TestHarness,
    companyId: string,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<ToolResultLike> {
    return (await harness.executeTool(tool, params, { companyId })) as ToolResultLike;
  }

  /**
   * Company A may read `alpha` only; company B may read everything. Both point at
   * the same corpus, so they share one cached index — the leak, if there is one,
   * has to survive that sharing rather than be masked by it.
   */
  async function twoCompanies(): Promise<{ a: TestHarness; b: TestHarness }> {
    fixture = await standardCorpus();
    const a = await boot({
      enabled: true,
      corpusRoot: fixture.root,
      allowedBundles: ["alpha"],
    });
    const b = await boot({ enabled: true, corpusRoot: fixture.root, allowedBundles: ["alpha", "beta", "gamma"] });
    return { a, b };
  }

  it("keeps a restricted company out of a bundle it was not granted", async () => {
    const { a, b } = await twoCompanies();

    // B is unrestricted, so this concept exists and is readable in this process.
    const forB = await call(b, COMPANY_B, "read_doc", { concept_id: "beta/index.md" });
    expect(forB.error, "the unrestricted company could not read the concept").toBeUndefined();

    // A was never shown `beta` and must not be able to name its way in.
    const forA = await call(a, COMPANY_A, "read_doc", { concept_id: "beta/index.md" });
    expect(forA.error ?? "", "a restricted company read an ungranted bundle").not.toBe("");
    expect(String(forA.content ?? "")).not.toContain("beta");
  });

  it("still lets the restricted company read what it was granted", async () => {
    // The other half: a rule that refuses everything is not a boundary, it is an
    // outage. `alpha` must remain readable after the check.
    const { a } = await twoCompanies();
    const granted = await call(a, COMPANY_A, "read_doc", { concept_id: "alpha/index.md" });
    expect(granted.error).toBeUndefined();
  });

  it("filters search results, so an ungranted bundle is not even discoverable", async () => {
    const { a, b } = await twoCompanies();

    const forB = await call(b, COMPANY_B, "search_docs", { query: "beta", limit: 20 });
    expect((forB.data as { results: unknown[] }).results.length).toBeGreaterThan(0);

    const forA = await call(a, COMPANY_A, "search_docs", { query: "beta", limit: 20 });
    const results = (forA.data as { results: Array<{ bundle: string }> }).results;
    expect(results.every((hit) => hit.bundle === "alpha")).toBe(true);
  });

  it("filters browsing, so an ungranted bundle is not listed", async () => {
    const { a } = await twoCompanies();
    const listing = await call(a, COMPANY_A, "list_docs", {});
    // A root listing may be the corpus's own index document; either way the
    // ungranted bundle must not appear as a navigable entry.
    const text = `${String(listing.content ?? "")}${JSON.stringify(listing.data ?? {})}`;
    expect(text).not.toContain("beta");
  });

  it("refuses an ungranted bundle through the explicit bundle parameter too", async () => {
    // Naming the bundle directly rather than through a concept path.
    const { a } = await twoCompanies();
    const direct = await call(a, COMPANY_A, "search_docs", { query: "x", bundle: "beta" });
    expect((direct.data as { bundleAllowed?: boolean }).bundleAllowed).toBe(false);
  });

  it("does not let two roots share an index", async () => {
    // Different corpora, one process. The store is keyed by root, so an index built
    // for one company must never answer the other's call.
    const other = await createFixtureCorpus({
      "zeta/index.md": [
        "---",
        'title: "Zeta"',
        'type: "Guide"',
        'description: "the other corpus"',
        "---",
        "",
        "zeta only",
        "",
      ].join("\n"),
    });
    try {
      const first = await boot({ enabled: true, corpusRoot: fixture.root, allowedBundles: ["alpha", "beta", "gamma"] });
      const second = await boot({ enabled: true, corpusRoot: other.root, allowedBundles: ["zeta"] });

      const fromFirst = await call(first, COMPANY_A, "read_doc", { concept_id: "zeta/index.md" });
      expect(fromFirst.error ?? "", "an index from another root answered this call").not.toBe("");

      const fromSecond = await call(second, COMPANY_B, "read_doc", { concept_id: "zeta/index.md" });
      expect(fromSecond.error).toBeUndefined();
    } finally {
      await other.cleanup();
    }
  });
});
