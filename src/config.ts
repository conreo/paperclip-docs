/**
 * Plugin configuration — the browser-safe half.
 *
 * This module is imported by the **UI bundle** as well as the worker, so it must
 * not reference a Node builtin: the UI bundle is built for the browser, and a
 * single `node:path` import in its graph fails the build (esbuild cannot resolve
 * a builtin for `platform: "browser"`, and externalising it would leave the page
 * importing a module the browser does not have).
 *
 * Everything that needs `node:os` / `node:path` — expanding `~`, validating that
 * the root is absolute — lives in `runtime-config.ts`, which only the worker
 * imports. What is left here is the part both sides genuinely share: the closed
 * JSON Schema, the operator-facing defaults, and the form helpers.
 *
 * ## Why the schema is closed
 *
 * The host validates a saved payload with Ajv against {@link INSTANCE_CONFIG_SCHEMA},
 * which is `additionalProperties: false`. A key that is not in the schema is
 * therefore a *rejected save*, not a preserved setting — and the failure an
 * operator sees is "Configuration does not match the plugin's instanceConfigSchema",
 * naming nothing. The runtime normaliser mirrors that closure and names the key;
 * this file only has to make sure the form never invents one.
 */

import {
  DEFAULT_CORPUS_ROOT,
  DEFAULT_MAX_DOC_CHARS,
  DEFAULT_MAX_RESULTS,
  DEFAULT_RAG_TOP_K,
  DEFAULT_RAG_WEIGHT,
  DEFAULT_REFRESH_MAX_AGE_DAYS,
  MAX_MAX_DOC_CHARS,
  MAX_MAX_RESULTS,
  MAX_REFRESH_MAX_AGE_DAYS,
  MIN_MAX_DOC_CHARS,
  MIN_MAX_RESULTS,
  MIN_REFRESH_MAX_AGE_DAYS,
  SOURCE_CONVERSIONS,
  SOURCE_KINDS,
} from "./constants.js";

/**
 * JSON Schema for the operator's instance config.
 *
 * `enabled` defaults to `false`: installing this plugin must not, by itself,
 * put a corpus in front of any agent. An admin turns it on deliberately.
 */
export const INSTANCE_CONFIG_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: {
      type: "boolean",
      title: "Enable documentation tools",
      description:
        "Turn the documentation tools on for this company. While off, every call is refused.",
      default: false,
    },
    corpusRoot: {
      type: "string",
      title: "Corpus directory",
      description:
        "The OKF bundle directory to serve. `~` is expanded to the worker user's home. Absolute paths only.",
      default: DEFAULT_CORPUS_ROOT,
    },
    allowedBundles: {
      type: "array",
      items: { type: "string" },
      title: "Bundles agents may read",
      description:
        "Which parts of the corpus this organization may read; empty means all of it. Set from the list of bundles that are actually in the corpus, not typed: unticking one removes it. Enforced on search, browsing and reading alike, so naming a page in a bundle that is not listed is refused rather than merely hidden. It does not decide which agents may call these tools — that is the tool grants on each agent.",
      default: [],
    },
    maxResults: {
      type: "number",
      title: "Maximum search results",
      description: "The hard ceiling on search_docs results, whatever an agent asks for.",
      default: DEFAULT_MAX_RESULTS,
    },
    maxDocChars: {
      type: "number",
      title: "Maximum document characters",
      description:
        "How much of a document read_doc may return before truncating. An unbounded result can evict a conversation.",
      default: DEFAULT_MAX_DOC_CHARS,
    },
    refresh: {
      type: "object",
      additionalProperties: false,
      title: "Refresh",
      description:
        "Ask a host-side runner to rebuild this corpus when it gets old. The plugin cannot fetch anything itself — the runtime gives it no way to run git or pandoc — so this writes a request into a declared folder and a runner on the host honours it.",
      default: { enabled: false, maxAgeDays: DEFAULT_REFRESH_MAX_AGE_DAYS },
      properties: {
        enabled: {
          type: "boolean",
          title: "Ask for rebuilds",
          description:
            "Write a refresh request when the corpus is older than the limit below. Off means the corpus is only ever updated by hand.",
          default: false,
        },
        maxAgeDays: {
          type: "number",
          title: "Rebuild when older than (days)",
          description: "How old the corpus may get before a rebuild is requested.",
          default: DEFAULT_REFRESH_MAX_AGE_DAYS,
        },
      },
    },
    rag: {
      type: "object",
      additionalProperties: false,
      title: "Semantic retrieval",
      description:
        "Off by default. With an embedding endpoint configured, search also ranks by meaning — useful when a page says \"single sign-on\" and never the letters SSO. Keyword search stays the baseline, and any failure here falls back to it.",
      default: { enabled: false, endpoint: "", model: "", secretRef: "", topK: DEFAULT_RAG_TOP_K, weight: DEFAULT_RAG_WEIGHT },
      properties: {
        enabled: { type: "boolean", title: "Use semantic retrieval", default: false },
        endpoint: { type: "string", title: "Embeddings endpoint (URL)" },
        model: { type: "string", title: "Embedding model" },
        secretRef: {
          type: "string",
          title: "API key reference",
          description: "A reference to a stored secret, never the key itself.",
        },
        topK: { type: "number", title: "Candidates from the index", default: DEFAULT_RAG_TOP_K },
        weight: {
          type: "number",
          title: "Weight (0 = keyword only, 1 = semantic only)",
          default: DEFAULT_RAG_WEIGHT,
        },
      },
    },
    sources: {
      type: "array",
      title: "Documentation sources",
      description:
        "This organization's registry: what to build, and which version of it. Adding a source is data, not code, so this is the whole of the per-organization work.",
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind"],
        properties: {
          id: { type: "string", title: "Bundle name" },
          title: { type: "string", title: "Display name" },
          kind: { type: "string", enum: [...SOURCE_KINDS], title: "Kind" },
          repo: { type: "string", title: "Repository" },
          url: { type: "string", title: "URL (llms.txt)" },
          ref: { type: "string", title: "Version to pin" },
          path: { type: "string", title: "Subdirectory" },
          convert: { type: "string", enum: [...SOURCE_CONVERSIONS], title: "Conversion" },
          include: { type: "array", items: { type: "string" }, title: "Include globs" },
          exclude: { type: "array", items: { type: "string" }, title: "Exclude globs" },
          tags: { type: "array", items: { type: "string" }, title: "Tags" },
        },
      },
    },
  },
};

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(`${field}: ${message}`);
    this.name = "ConfigError";
  }
}

/** The property names {@link INSTANCE_CONFIG_SCHEMA} actually allows. */
export function settableConfigKeys(): string[] {
  const properties = (INSTANCE_CONFIG_SCHEMA as { properties?: Record<string, unknown> })
    .properties;
  return properties ? Object.keys(properties) : [];
}

/**
 * The five fields the operator can set, as a typed view of the config document.
 *
 * `corpusRoot` here stays in whatever form it was stored — including a leading
 * `~` — because this feeds a form, and the operator should see the value they
 * typed. The runtime expands it.
 */
/** One entry of the per-organization source registry, as the form holds it. */
export interface OperatorSource {
  id: string;
  title?: string;
  kind: string;
  repo?: string;
  url?: string;
  ref?: string;
  path?: string;
  convert?: string;
  include?: string[];
  exclude?: string[];
  tags?: string[];
}

export interface OperatorRefresh {
  enabled: boolean;
  maxAgeDays: number;
}

export interface OperatorRag {
  enabled: boolean;
  endpoint: string;
  model: string;
  secretRef: string;
  topK: number;
  weight: number;
}

export interface OperatorConfig {
  enabled: boolean;
  corpusRoot: string;
  allowedBundles: string[];
  maxResults: number;
  maxDocChars: number;
  refresh: OperatorRefresh;
  sources: OperatorSource[];
  rag: OperatorRag;
}

/** The schema defaults, which is what an unconfigured plugin behaves as. */
export const OPERATOR_CONFIG_DEFAULTS: OperatorConfig = {
  enabled: false,
  corpusRoot: DEFAULT_CORPUS_ROOT,
  allowedBundles: [],
  maxResults: DEFAULT_MAX_RESULTS,
  maxDocChars: DEFAULT_MAX_DOC_CHARS,
  refresh: { enabled: false, maxAgeDays: DEFAULT_REFRESH_MAX_AGE_DAYS },
  sources: [],
  rag: {
    enabled: false,
    endpoint: "",
    model: "",
    secretRef: "",
    topK: DEFAULT_RAG_TOP_K,
    weight: DEFAULT_RAG_WEIGHT,
  },
};

function operatorBool(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key];
  return typeof value === "boolean" ? value : fallback;
}

function operatorNumber(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Read the operator's config out of a stored document.
 *
 * A missing or wrongly-typed key falls back to the schema default rather than
 * throwing: this feeds a settings form, and a form that refuses to open because
 * one key drifted is worse than a form showing the default.
 */
export function readOperatorConfig(raw: unknown): OperatorConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...OPERATOR_CONFIG_DEFAULTS };
  }
  const record = raw as Record<string, unknown>;

  const bundles = Array.isArray(record["allowedBundles"])
    ? record["allowedBundles"].filter((entry): entry is string => typeof entry === "string")
    : [...OPERATOR_CONFIG_DEFAULTS.allowedBundles];

  const root = record["corpusRoot"];

  return {
    enabled: operatorBool(record, "enabled", OPERATOR_CONFIG_DEFAULTS.enabled),
    corpusRoot:
      typeof root === "string" && root.trim().length > 0
        ? root.trim()
        : OPERATOR_CONFIG_DEFAULTS.corpusRoot,
    allowedBundles: bundles,
    maxResults: operatorNumber(
      record,
      "maxResults",
      OPERATOR_CONFIG_DEFAULTS.maxResults,
      MIN_MAX_RESULTS,
      MAX_MAX_RESULTS,
    ),
    maxDocChars: operatorNumber(
      record,
      "maxDocChars",
      OPERATOR_CONFIG_DEFAULTS.maxDocChars,
      MIN_MAX_DOC_CHARS,
      MAX_MAX_DOC_CHARS,
    ),
    refresh: readOperatorRefresh(record["refresh"]),
    sources: readOperatorSources(record["sources"]),
    rag: readOperatorRag(record["rag"]),
  };
}

/** The RAG block, read leniently: this feeds a form, not a decision. */
function readOperatorRag(raw: unknown): OperatorRag {
  const fallback = OPERATOR_CONFIG_DEFAULTS.rag;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...fallback };
  const record = raw as Record<string, unknown>;
  const text = (key: string): string =>
    typeof record[key] === "string" ? (record[key] as string) : "";
  return {
    enabled: operatorBool(record, "enabled", fallback.enabled),
    endpoint: text("endpoint"),
    model: text("model"),
    secretRef: text("secretRef"),
    topK: operatorNumber(record, "topK", fallback.topK, 1, 200),
    weight: operatorNumber(record, "weight", fallback.weight, 0, 1),
  };
}

/**
 * The refresh block, read leniently.
 *
 * Feeds a form: a key that drifted shows its default rather than preventing the
 * page from opening. The worker's normaliser is the strict one.
 */
function readOperatorRefresh(raw: unknown): OperatorRefresh {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...OPERATOR_CONFIG_DEFAULTS.refresh };
  }
  const record = raw as Record<string, unknown>;
  return {
    enabled: operatorBool(record, "enabled", OPERATOR_CONFIG_DEFAULTS.refresh.enabled),
    maxAgeDays: operatorNumber(
      record,
      "maxAgeDays",
      OPERATOR_CONFIG_DEFAULTS.refresh.maxAgeDays,
      MIN_REFRESH_MAX_AGE_DAYS,
      MAX_REFRESH_MAX_AGE_DAYS,
    ),
  };
}

/** The registry, read leniently: an entry without an id or kind is dropped. */
function readOperatorSources(raw: unknown): OperatorSource[] {
  if (!Array.isArray(raw)) return [];
  const out: OperatorSource[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record["id"] === "string" ? record["id"].trim() : "";
    const kind = typeof record["kind"] === "string" ? record["kind"].trim() : "";
    if (!id || !kind) continue;
    const strings = (key: string): string[] | undefined =>
      Array.isArray(record[key])
        ? (record[key] as unknown[]).filter((v): v is string => typeof v === "string")
        : undefined;
    out.push({
      id,
      kind,
      title: typeof record["title"] === "string" ? record["title"] : undefined,
      repo: typeof record["repo"] === "string" ? record["repo"] : undefined,
      url: typeof record["url"] === "string" ? record["url"] : undefined,
      ref: typeof record["ref"] === "string" ? record["ref"] : undefined,
      path: typeof record["path"] === "string" ? record["path"] : undefined,
      convert: typeof record["convert"] === "string" ? record["convert"] : undefined,
      include: strings("include"),
      exclude: strings("exclude"),
      tags: strings("tags"),
    });
  }
  return out;
}

/**
 * The allowlist after an operator ticks or unticks one bundle.
 *
 * ## Why this is a function and not two lines in the component
 *
 * The stored value has a special case — empty means *every* bundle — and that case
 * is load-bearing: it is what lets a corpus grow without silently hiding new
 * bundles. Anything that turns a real list back into the empty one by accident
 * widens access, and anything that fails to turn a complete list back into the empty
 * one means a newly built bundle arrives invisible to every agent.
 *
 * So the rule is written once, here, and tested:
 *
 *   - empty means "everything discovered", which is the state the page shows first;
 *   - ticking or unticking is applied to that effective set;
 *   - the result is stored as the empty list **only** when it covers every discovered
 *     bundle and names nothing else. A set that covers everything *and* carries a
 *     stale name is stored as a list, because canonicalising it would quietly grant
 *     whatever gets built next.
 */
/**
 * The bundles this organization may read, out of the ones the corpus has.
 *
 * The same "empty means everything" rule {@link toggleBundle} stores, applied for
 * display: the page renders one row per discovered bundle, so nothing can be hidden
 * by the config not mentioning it.
 */
export function effectiveBundles(discovered: string[], allowed: string[]): string[] {
  return allowed.length > 0 ? allowed : discovered;
}

export function toggleBundle(
  discovered: string[],
  allowed: string[],
  bundle: string,
  keep: boolean,
): string[] {
  const effective = new Set(allowed.length > 0 ? allowed : discovered);
  if (keep) effective.add(bundle);
  else effective.delete(bundle);

  const coversEverything = discovered.every((name) => effective.has(name));
  const namesSomethingElse = [...effective].some((name) => !discovered.includes(name));
  if (coversEverything && !namesSomethingElse) return [];
  return [...effective].sort();
}

export interface SavePayload {
  /** What to send: exactly the schema's properties, nothing else. */
  config: Record<string, unknown>;
  /** Stored keys this payload leaves out, for the operator to see. */
  droppedKeys: string[];
}

/**
 * Build the configuration to save.
 *
 * ## Why this does not merge the stored document wholesale
 *
 * The reference plugin's first version merged stored keys with the form and
 * posted the result, on the reasoning that a key the form does not show must not
 * be dropped. That is the right instinct for a governance document and the
 * **wrong** one here, because the server validates this payload with Ajv against
 * `instanceConfigSchema`, which is closed (`additionalProperties: false`):
 *
 *     Configuration does not match the plugin's instanceConfigSchema
 *
 * So every extra key is not preserved, it is a rejected request: an organisation
 * carrying an older document could not save settings at all, and the form
 * appeared to fail for no visible reason. (Deterministic, too — it broke on the
 * orgs with a history and worked on the orgs without one.)
 *
 * The document an operator can edit is exactly the schema, so that is what this
 * returns. Keys outside the schema are reported in `droppedKeys` rather than
 * silently discarded, because saying so is better than pretending they were
 * never there.
 */
export function operatorConfigForSave(
  stored: unknown,
  edits: Partial<OperatorConfig>,
): SavePayload {
  const record =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};

  const allowed = settableConfigKeys();
  const config: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in record) config[key] = record[key];
  }

  for (const [key, value] of Object.entries(edits)) {
    // Only schema keys, so a caller cannot smuggle one in through `edits`.
    if (value === undefined || !allowed.includes(key)) continue;
    config[key] = value;
  }

  const droppedKeys = Object.keys(record).filter((key) => !allowed.includes(key));
  return { config, droppedKeys };
}
