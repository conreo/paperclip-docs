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
  MAX_MAX_DOC_CHARS,
  MAX_MAX_RESULTS,
  MIN_MAX_DOC_CHARS,
  MIN_MAX_RESULTS,
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
        "An allowlist of top-level bundle directories. Leave empty to serve every bundle in the corpus.",
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
export interface OperatorConfig {
  enabled: boolean;
  corpusRoot: string;
  allowedBundles: string[];
  maxResults: number;
  maxDocChars: number;
}

/** The schema defaults, which is what an unconfigured plugin behaves as. */
export const OPERATOR_CONFIG_DEFAULTS: OperatorConfig = {
  enabled: false,
  corpusRoot: DEFAULT_CORPUS_ROOT,
  allowedBundles: [],
  maxResults: DEFAULT_MAX_RESULTS,
  maxDocChars: DEFAULT_MAX_DOC_CHARS,
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
  };
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
