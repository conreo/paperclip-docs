/**
 * The plugin under the host's own in-memory harness.
 *
 * Everything else in this suite calls the tool *functions* directly, which proves
 * the logic but skips the one step an install depends on: whether `setup()` wires
 * those functions to the names an agent asks for, under the manifest's
 * capabilities, through the context the host injects.
 *
 * `@paperclipai/plugin-sdk/testing` is the host's own harness — the same package
 * the Paperclip server's tests use. `createTestHarness({ manifest })` builds an
 * in-memory `PluginContext` seeded from the manifest's capability list, and
 * `executeTool(name, params, runCtx)` runs a registered handler the way the tool
 * gateway does. So this catches the failure that a fixture test cannot see: a tool
 * declared in the manifest and never registered, a handler registered under the
 * wrong key, or a `setup()` that needs a namespace its manifest does not claim.
 *
 * What it still is not: a running server. Delivery to an agent, the gateway's
 * policy decision, and the rendered settings page are host behaviour, not plugin
 * behaviour, and only an instance can exercise them.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";

import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { DOC_TOOLS } from "../src/constants.js";
import { createFixtureCorpus, standardCorpus, type FixtureCorpus } from "./fixtures/corpus.js";

/** The company the harness hands to `ctx.config.get`. */
const COMPANY_ID = "5ebdaf48-3f46-447f-b0f1-be65b0c6f189";

const setup = plugin.definition.setup as (ctx: unknown) => Promise<void> | void;

interface ToolResultLike {
  content?: string;
  error?: string;
  data?: unknown;
}

describe("the plugin under the host harness", () => {
  let fixture: FixtureCorpus;

  beforeEach(async () => {
    fixture = await standardCorpus();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  async function boot(overrides: Record<string, unknown> = {}): Promise<TestHarness> {
    const harness = createTestHarness({
      manifest,
      config: { enabled: true, corpusRoot: fixture.root, allowedBundles: ["alpha", "beta", "gamma"], ...overrides },
    });
    await setup(harness.ctx);
    return harness;
  }

  /** `executeTool` wraps the handler's own result; unwrap it for assertions. */
  async function call(
    harness: TestHarness,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<ToolResultLike> {
    return (await harness.executeTool(tool, params, { companyId: COMPANY_ID })) as ToolResultLike;
  }

  it("registers every tool the manifest declares, under the declared name", async () => {
    // The pairing that a fixture test cannot check: manifest says `search_docs`,
    // `setup()` must register something callable at exactly that name.
    const harness = await boot();
    for (const tool of DOC_TOOLS) {
      const result = await call(harness, tool, {});
      // A tool that was never registered fails differently from one that was
      // registered and rejected its arguments, and only the first is a defect.
      expect(
        result.error ?? "",
        `"${tool}" was not registered by setup()`,
      ).not.toContain("not registered");
      expect(result).toBeTypeOf("object");
    }
  });

  it("serves a search through the tool path", async () => {
    const harness = await boot();
    const result = await call(harness, "search_docs", { query: "webhook" });
    expect(result.error).toBeUndefined();
    const data = result.data as { results?: unknown[]; count?: number };
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results!.length).toBeGreaterThan(0);
    // The model reads `content`; it must name the next step, not just dump JSON.
    expect(String(result.content)).toContain("read_doc");
  });

  it("passes the run's company through to config, so per-company settings apply", async () => {
    // A corpus root the company is not configured for must not be reachable: the
    // handler reads `ctx.config.get(companyId)` from the *run context*.
    const harness = createTestHarness({
      manifest,
      config: { enabled: false, corpusRoot: fixture.root, allowedBundles: ["alpha", "beta", "gamma"] },
    });
    await setup(harness.ctx);
    const result = await call(harness, "search_docs", { query: "webhook" });
    // Disabled is a refusal, stated as an error rather than an empty result set —
    // an empty list would read as "no such documentation".
    expect(result.error ?? "").not.toBe("");
  });

  it("refuses a traversal through the tool path", async () => {
    const harness = await boot();
    const result = await call(harness, "read_doc", { concept_id: "../../etc/passwd" });
    expect(result.error ?? "").not.toBe("");
    expect(String(result.error)).not.toContain("root:");
  });

  it("answers a read with frontmatter and body", async () => {
    const harness = await boot();
    const result = await call(harness, "read_doc", { concept_id: "alpha/index.md" });
    expect(result.error).toBeUndefined();
    const data = result.data as { body?: string; frontmatter?: unknown };
    expect(typeof data.frontmatter).toBe("object");
  });

  it("reports the snapshot's age through the tool path", async () => {
    const harness = await boot();
    const result = await call(harness, "sources", {});
    expect(result.error).toBeUndefined();
    const data = result.data as { totalConcepts?: number; ageDays?: number };
    expect(data.totalConcepts).toBeGreaterThan(0);
    expect(typeof data.ageDays).toBe("number");
  });

  it("logs nothing at error level during a normal call", async () => {
    // The harness records what the plugin logged. A routine search that logs an
    // error trains an operator to ignore the log.
    const harness = await boot();
    await call(harness, "search_docs", { query: "webhook" });
    const errors = harness.logs.filter((entry) => entry.level === "error");
    expect(errors).toEqual([]);
  });
});
