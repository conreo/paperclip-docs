/**
 * Plugin worker entrypoint.
 *
 * ## Call path
 *
 * ```
 * agent calls paperclip-docs:search_docs
 *   → Paperclip tool gateway: policyService.decide() over operator profiles,
 *     policies and bindings; writes a tool_invocation row and a call event
 *                                                      ← host-owned, cannot be skipped
 *   → this worker's handler
 *       → re-read this company's config
 *       → refuse when `enabled` is false
 *       → validate arguments against the declared schema
 *       → index the corpus (lazily; cached until the corpus's mtime changes)
 *       → resolve every path against the corpus root, refusing escapes
 *       → clamp the result to the operator's caps
 *   → result validated by the host's content guards
 * ```
 *
 * ## Why this is a *serving* plugin
 *
 * The corpus is built by Python (`build_okf.py` and friends) and this plugin
 * never writes to it. That split is deliberate: scraping, cleaning and
 * converting vendor documentation is a batch job with its own failure modes, and
 * running it inside a worker would mean an agent could trigger a re-scrape. Here
 * the artifact is an input, the build is out of band, and the plugin's whole job
 * is to answer questions about it accurately — including how old it is.
 *
 * ## Module-level state
 *
 * One `CorpusStore` per worker process is the only mutable state. It holds the
 * parsed index and its mtime signature; nothing else survives a request, and
 * nothing is written anywhere. Two small sets track registration, because the host
 * can call `setup()` more than once and `ctx.tools.register` is not idempotent:
 * one keyed by context to decide whether to register, one flat set to report what
 * this plugin offers.
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";

import { PLUGIN_ID } from "./constants.js";
import { normalizeConfig, type RuntimeConfig } from "./runtime-config.js";
import { DATA_KEYS } from "./plugin-keys.js";
import { CorpusStore } from "./corpus/store.js";
import { DOC_TOOL_SPECS, toJsonSchema, type DocToolSpec } from "./tools/catalog.js";
import { listDocs, readDoc, searchDocs, sources, statusPayload } from "./tools/handlers.js";
import { validateArguments } from "./tools/validate.js";

// ---------------------------------------------------------------------------
// Module state (one worker process)
// ---------------------------------------------------------------------------

const store = new CorpusStore();

/**
 * Tool names this worker has registered, for health and logging.
 *
 * A plain set for reporting; the *guard* against double registration is per
 * context, below.
 */
const registeredTools = new Set<string>();

/**
 * Which tools each context has already been given.
 *
 * `ctx.tools.register` is not idempotent, so a second `setup()` on the **same**
 * context must not register twice. But a *different* context has its own, empty
 * tool registry — and a module-level guard cannot tell the two apart, so it would
 * skip registration and leave that context with no tools at all. That failure is
 * invisible in production, where each worker process gets exactly one context, and
 * immediate under the host's test harness, which boots a fresh context per test.
 *
 * Keyed weakly so a context that goes away is not kept alive by this map.
 */
const registeredByContext = new WeakMap<object, Set<string>>();

function toolsFor(ctx: object): Set<string> {
  const existing = registeredByContext.get(ctx);
  if (existing) return existing;
  const created = new Set<string>();
  registeredByContext.set(ctx, created);
  return created;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Read and normalize config for one company.
 *
 * A malformed config must never fall back to permissive defaults: if the
 * operator wrote something we cannot parse, every call is refused until they fix
 * it, and the reason says why. Falling back to "disabled with default paths"
 * would be *safe* but would hide the mistake, so the error is carried out
 * alongside the inert config and reported.
 */
async function loadConfig(
  ctx: PluginContext,
  companyId?: string,
): Promise<{ config: RuntimeConfig; error: string | null }> {
  try {
    const raw = await ctx.config.get(companyId);
    return { config: normalizeConfig(raw), error: null };
  } catch (error) {
    return {
      config: normalizeConfig(undefined),
      error:
        error instanceof Error
          ? `Plugin configuration is invalid: ${error.message}`
          : "Plugin configuration is invalid",
    };
  }
}

// ---------------------------------------------------------------------------
// The tool handler
// ---------------------------------------------------------------------------

/**
 * The single gate every tool call passes through.
 *
 * `enabled` is re-read per call rather than cached at setup, because Paperclip's
 * plugin config is company-scoped: an instance-level read during `setup` cannot
 * know whether any particular company has opted in, and a config change must
 * take effect without a worker restart.
 */
async function handleToolCall(
  ctx: PluginContext,
  spec: DocToolSpec,
  rawParams: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const { config, error: configError } = await loadConfig(ctx, runCtx.companyId);
  if (configError) {
    return { error: configError };
  }

  if (!config.enabled) {
    return {
      error:
        "Documentation tools are turned off for this organization. An admin can switch them on in Settings → Plugins → Docs.",
    };
  }

  const parsed = validateArguments(spec, rawParams);
  if (!parsed.ok) {
    return { error: parsed.error };
  }

  switch (spec.name) {
    case "search_docs":
      return searchDocs(store, config, parsed.args);
    case "read_doc":
      return readDoc(store, config, parsed.args);
    case "list_docs":
      return listDocs(store, config, parsed.args);
    case "sources":
      return sources(store, config);
    default:
      // Unreachable for a declared spec, but an explicit refusal is better than
      // an accidental `undefined` result if a fifth tool is ever added to the
      // catalog without a case here.
      return { error: `No handler is implemented for tool "${spec.name}"` };
  }
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    // `ctx.config.get()` with no company id is a *host-scoped* read, and the
    // host does not guarantee one during setup. A failure here must not abort
    // startup: registration is unconditional and every call re-reads the
    // company-scoped config, so the plugin can come up inert and become useful
    // as soon as an operator configures a company.
    let config: RuntimeConfig;
    let error: string | null;
    try {
      ({ config, error } = await loadConfig(ctx));
    } catch (thrown) {
      config = normalizeConfig(undefined);
      error =
        thrown instanceof Error
          ? `Plugin configuration could not be read: ${thrown.message}`
          : "Plugin configuration could not be read";
    }

    if (error) {
      ctx.logger.error(
        "paperclip-docs is running with default (disabled) configuration",
        { error },
      );
    }

    const alreadyRegistered = toolsFor(ctx);
    for (const spec of DOC_TOOL_SPECS) {
      if (alreadyRegistered.has(spec.name)) continue;
      ctx.tools.register(
        spec.name,
        {
          displayName: spec.displayName,
          description: spec.description,
          parametersSchema: toJsonSchema(spec),
        },
        async (params, runCtx): Promise<ToolResult> =>
          handleToolCall(ctx, spec, params, runCtx),
      );
      alreadyRegistered.add(spec.name);
      registeredTools.add(spec.name);
    }

    ctx.logger.info("paperclip-docs registered documentation tools", {
      tools: [...registeredTools],
      corpusRoot: config.corpusRoot,
      // Not a gate — each company's own config decides whether calls succeed.
      instanceDefaultEnabled: config.enabled,
    });

    // -----------------------------------------------------------------
    // Data handlers — the settings page's read-only view of the corpus.
    // -----------------------------------------------------------------

    /**
     * Corpus status for the settings page.
     *
     * Reports a missing corpus as data rather than an error: the page exists
     * partly to answer "why is this not working?", and a blank failure answers
     * nothing. The absolute root is included because the operator is the
     * audience here and they need to know which directory was read.
     */
    ctx.data.register(DATA_KEYS.corpusStatus, async (params) => {
      const companyId =
        typeof params?.["companyId"] === "string" && params["companyId"].trim().length > 0
          ? params["companyId"].trim()
          : undefined;
      const { config: scoped, error: scopedError } = await loadConfig(ctx, companyId);
      const status = await store.describe(scoped.corpusRoot);
      return {
        ...statusPayload(status, scoped, scoped.enabled),
        configError: scopedError,
      };
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: `${registeredTools.size} documentation tools registered; ${store.size} corpus index(es) loaded`,
      details: { registeredTools: [...registeredTools], indexedRoots: store.size },
    };
  },

  async onValidateConfig(config) {
    try {
      normalizeConfig(config);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        errors: [error instanceof Error ? error.message : "Invalid configuration"],
      };
    }
  },
});

export default plugin;

// `runWorker` self-guards: it starts an RPC host only when this module is the
// process entrypoint, so importing the worker from a test does not open one.
// `tests/worker-registration.spec.ts` stubs it anyway, which is what proves the
// test is exercising `setup()` and not a live worker.
runWorker(plugin, import.meta.url);

/** Re-exported for the architecture test / diagnostics. */
export { PLUGIN_ID };
