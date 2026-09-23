/**
 * The worker's real `setup()` against the real bridge keys.
 *
 * `bridge-keys.spec.ts` checks that the constants and the UI agree. This goes one
 * step further and runs the actual registration: it stubs `runWorker` (which is
 * called on import and would otherwise start a worker), invokes `setup` with a
 * recording mock context, and asserts that every key the UI calls was registered
 * by the code that runs in production.
 *
 * The tool handlers are then called for real against a temp fixture corpus, so
 * "registered" is not mistaken for "works".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runWorker = vi.fn();
vi.mock("@paperclipai/plugin-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/plugin-sdk")>();
  return { ...actual, runWorker: (...args: unknown[]) => runWorker(...args) };
});

import { DOC_TOOLS } from "../src/constants.js";
import { ALL_ACTION_KEYS, ALL_DATA_KEYS, DATA_KEYS } from "../src/plugin-keys.js";
import { standardCorpus, type FixtureCorpus } from "./fixtures/corpus.js";

type Handler = (params: Record<string, unknown>, runCtx?: unknown) => Promise<unknown>;

/** A context that records what `setup` registers and answers nothing else. */
function recordingContext(config: Record<string, unknown> | (() => Promise<unknown>)) {
  const data = new Map<string, unknown>();
  const actions = new Map<string, unknown>();
  const tools = new Map<string, { declaration: unknown; handler: unknown }>();

  const ctx = {
    data: { register: (key: string, handler: unknown) => data.set(key, handler) },
    actions: { register: (key: string, handler: unknown) => actions.set(key, handler) },
    tools: {
      register: (name: string, declaration: unknown, handler: unknown) =>
        tools.set(name, { declaration, handler }),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    activity: { log: async () => {} },
    state: { get: async () => null, set: async () => {} },
    streams: { emit: () => {} },
    config: {
      get: async () => (typeof config === "function" ? config() : config),
    },
    // Everything else the worker touches during setup is optional enough that an
    // empty object is fine; setup must not depend on call results.
    projects: {},
    agents: {},
    companies: {},
    localFolders: {},
  };

  return { ctx, data, actions, tools };
}

async function loadAndSetup(config: Record<string, unknown> | (() => Promise<unknown>)) {
  vi.resetModules();
  const registered = recordingContext(config);
  const module = await import("../src/worker.js");
  // `definePlugin` returns `{ definition }`; the host calls the lifecycle
  // methods from there, so the test does the same.
  const plugin = module.default as unknown as {
    definition: {
      setup: (ctx: unknown) => Promise<void> | void;
      onHealth: () => Promise<{ status: string; message?: string }>;
    };
  };
  await plugin.definition.setup(registered.ctx);
  return { ...registered, plugin };
}

const RUN_CTX = { companyId: "company-1", agentId: "agent-1", runId: "run-1", projectId: "p-1" };

let fixture: FixtureCorpus;

beforeEach(async () => {
  runWorker.mockClear();
  fixture = await standardCorpus();
});

afterEach(async () => {
  await fixture.cleanup();
});

describe("worker setup registration", () => {
  it("does not start a worker just by importing the module", async () => {
    // `runWorker` is called at module scope in production. The stub proves the
    // test is exercising the definition and not a live worker: a real call would
    // have opened the stdio RPC channel.
    const registered = await loadAndSetup({ enabled: true, corpusRoot: fixture.root });
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(registered.tools.size).toBe(DOC_TOOLS.length);
  });

  it("registers every declared tool with a JSON schema", async () => {
    const registered = await loadAndSetup({ enabled: true, corpusRoot: fixture.root });
    for (const name of DOC_TOOLS) {
      const entry = registered.tools.get(name);
      expect(entry, `tool "${name}" was not registered`).toBeDefined();
      const declaration = entry!.declaration as {
        displayName?: string;
        description?: string;
        parametersSchema?: Record<string, unknown>;
      };
      expect(declaration.displayName).toBeTruthy();
      expect(declaration.description).toBeTruthy();
      expect(declaration.parametersSchema?.["type"]).toBe("object");
      expect(declaration.parametersSchema?.["additionalProperties"]).toBe(false);
    }
  });

  it("registers every key in the shared registry", async () => {
    const registered = await loadAndSetup({ enabled: true, corpusRoot: fixture.root });
    for (const key of ALL_DATA_KEYS) {
      expect([...registered.data.keys()], `data key "${key}" was not registered`).toContain(key);
    }
    for (const key of ALL_ACTION_KEYS) {
      expect([...registered.actions.keys()], `action key "${key}" was not registered`).toContain(key);
    }
  });

  it("registers no key that is not in the registry", async () => {
    const registered = await loadAndSetup({ enabled: true, corpusRoot: fixture.root });
    const extraData = [...registered.data.keys()].filter((key) => !ALL_DATA_KEYS.includes(key));
    const extraActions = [...registered.actions.keys()].filter(
      (key) => !ALL_ACTION_KEYS.includes(key),
    );
    expect(extraData, "data keys registered but not in DATA_KEYS").toEqual([]);
    expect(extraActions, "action keys registered but not in ACTION_KEYS").toEqual([]);
  });

  it("gives every handler a callable", async () => {
    const registered = await loadAndSetup({ enabled: true, corpusRoot: fixture.root });
    for (const [key, handler] of registered.data) {
      expect(handler, `data handler for "${key}" is not callable`).toBeTypeOf("function");
    }
    for (const [name, entry] of registered.tools) {
      expect(entry.handler, `tool handler for "${name}" is not callable`).toBeTypeOf("function");
    }
  });
});

describe("registered handlers do real work", () => {
  it("answers search_docs from the configured corpus", async () => {
    const registered = await loadAndSetup({ enabled: true, corpusRoot: fixture.root });
    const handler = registered.tools.get("search_docs")!.handler as Handler;
    const result = (await handler({ query: "webhook" }, RUN_CTX)) as {
      content?: string;
      error?: string;
    };
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("alpha/webhooks.md");
  });

  it("clamps results to the configured ceiling", async () => {
    const registered = await loadAndSetup({
      enabled: true,
      corpusRoot: fixture.root,
      maxResults: 1,
    });
    const handler = registered.tools.get("search_docs")!.handler as Handler;
    const result = (await handler({ query: "alpha", limit: 50 }, RUN_CTX)) as {
      data?: { count: number };
    };
    expect(result.data?.count).toBe(1);
  });

  it("reports corpus status to the settings page", async () => {
    const registered = await loadAndSetup({ enabled: true, corpusRoot: fixture.root });
    const handler = registered.data.get(DATA_KEYS.corpusStatus) as Handler;
    const payload = (await handler({ companyId: "company-1" })) as {
      enabled: boolean;
      exists: boolean;
      totalConcepts: number;
      bundleCount: number;
      newestTimestamp: string;
    };
    expect(payload.enabled).toBe(true);
    expect(payload.exists).toBe(true);
    expect(payload.totalConcepts).toBe(14);
    expect(payload.bundleCount).toBe(3);
    expect(payload.newestTimestamp).toBe("2026-03-01T00:00:00Z");
  });

  it("refuses every tool while the company has it disabled", async () => {
    const registered = await loadAndSetup({ enabled: false, corpusRoot: fixture.root });
    const handler = registered.tools.get("search_docs")!.handler as Handler;
    const result = (await handler({ query: "webhook" }, RUN_CTX)) as { error?: string };
    expect(result.error).toMatch(/turned off/i);
  });

  it("refuses rather than guessing when the config cannot be read", async () => {
    const registered = await loadAndSetup(async () => {
      throw new Error("bad company config");
    });
    const handler = registered.tools.get("search_docs")!.handler as Handler;
    const result = (await handler({ query: "webhook" }, RUN_CTX)) as { error?: string };
    expect(result.error).toMatch(/configuration is invalid/i);
  });

  it("reports the four tools in health", async () => {
    const registered = await loadAndSetup({ enabled: true, corpusRoot: fixture.root });
    const health = await registered.plugin.definition.onHealth();
    expect(health.status).toBe("ok");
    expect(health.message).toContain("4 documentation tools");
  });
});
