/**
 * Plugin configuration — the Node-side normaliser.
 *
 * Split from `config.ts` because this half needs `node:os` and `node:path`, and
 * `config.ts` is imported by the **UI bundle**, which is built for the browser.
 * One `node:path` import in that graph fails the build outright; externalising it
 * would only move the failure to page load. Only the worker imports this module.
 *
 * Everything is normalised here into {@link RuntimeConfig} with defaults applied,
 * so no other module reasons about a missing key.
 *
 * ## Why the normaliser is strict
 *
 * The host validates a saved payload with Ajv against the closed schema in
 * `config.ts`, which means an unknown key is a rejected request rather than a
 * preserved setting — and the message names nothing. This module mirrors that
 * closure and *names the offending key*, so the same mistake produces a sentence
 * that identifies it. Silently dropping an unknown key would be worse than
 * either: the operator would believe a setting took effect when it never existed.
 */

import os from "node:os";
import path from "node:path";

import {
  EXAMPLE_CORPUS_ROOT,
  DEFAULT_MAX_DOC_CHARS,
  DEFAULT_MAX_RESULTS,
  DEFAULT_RAG_TOP_K,
  DEFAULT_RAG_WEIGHT,
  DEFAULT_REFRESH_MAX_AGE_DAYS,
  MAX_ARG_STRING_CHARS,
  MAX_MAX_DOC_CHARS,
  MAX_MAX_RESULTS,
  MAX_RAG_TOP_K,
  MAX_RAG_WEIGHT,
  MAX_REFRESH_MAX_AGE_DAYS,
  MIN_MAX_DOC_CHARS,
  MIN_MAX_RESULTS,
  MIN_RAG_TOP_K,
  MIN_RAG_WEIGHT,
  MIN_REFRESH_MAX_AGE_DAYS,
  SOURCE_CONVERSIONS,
  SOURCE_KINDS,
  type SourceConversion,
  type SourceKind,
} from "./constants.js";
import { ConfigError, settableConfigKeys } from "./config.js";

/** One entry of an organization's source registry, after normalisation. */
export interface RuntimeSourceDeclaration {
  /** Bundle name. Also the directory the build writes, so it is a plain name. */
  id: string;
  title: string;
  kind: SourceKind;
  repo: string;
  url: string;
  ref: string;
  path: string;
  convert: SourceConversion;
  include: string[];
  exclude: string[];
  tags: string[];
}

export interface RuntimeRefreshConfig {
  enabled: boolean;
  maxAgeDays: number;
}

/**
 * Optional semantic retrieval.
 *
 * `enabled` defaults false: this is the only part of the plugin that talks to
 * anything outside the host, and the only part that sends a query anywhere. Keyword
 * search needs none of it.
 */
export interface RuntimeRagConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  /** A secret *reference*, never the key itself: the value stays in the host. */
  secretRef: string;
  topK: number;
  weight: number;
}

/** The full runtime surface after defaults are applied. */
export interface RuntimeConfig {
  enabled: boolean;
  /** Absolute path to the OKF bundle directory, with `~` already expanded. */
  corpusRoot: string;
  /** Bundle names agents may read; empty means every bundle. */
  allowedBundles: string[];
  /** Hard ceiling on `search_docs` results. */
  maxResults: number;
  /** Character cap for one `read_doc` body. */
  maxDocChars: number;
  /** Whether, and how eagerly, to ask a host-side runner for a rebuild. */
  refresh: RuntimeRefreshConfig;
  /** What this organization wants built. Read only to write a refresh request. */
  sources: RuntimeSourceDeclaration[];
  /** Optional semantic retrieval over the corpus. */
  rag: RuntimeRagConfig;
}

/** A registry this large is a mistake, not an intention. */
const MAX_SOURCES = 200;

/**
 * Expand a leading `~` against a home directory.
 *
 * Split out with a `home` parameter so tests exercise the rule without
 * depending on the machine running them.
 */
export function expandHome(value: string, home: string = os.homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

/** The defaults, with `corpusRoot` already expanded. */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  enabled: false,
  // Empty: this organization has no corpus until one is named for it. See
  // `EXAMPLE_CORPUS_ROOT` for why there is no shared default.
  corpusRoot: "",
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

function readBool(
  raw: Record<string, unknown>,
  key: keyof RuntimeConfig,
  fallback: boolean,
): boolean {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new ConfigError("must be a boolean", key);
  }
  return value;
}

function readNumber(
  raw: Record<string, unknown>,
  key: keyof RuntimeConfig,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError("must be a finite number", key);
  }
  if (value < min || value > max) {
    throw new ConfigError(`must be between ${min} and ${max}`, key);
  }
  return Math.floor(value);
}

function readString(
  raw: Record<string, unknown>,
  key: keyof RuntimeConfig,
  fallback: string,
  maxLength = MAX_ARG_STRING_CHARS,
): string {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError("must be a non-empty string", key);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ConfigError(`must be at most ${maxLength} characters`, key);
  }
  return trimmed;
}

function readStringArray(raw: Record<string, unknown>, key: keyof RuntimeConfig): string[] {
  const value = raw[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError("must be an array of strings", key);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ConfigError(`entry ${index} must be a non-empty string`, key);
    }
    const trimmed = entry.trim();
    if (trimmed.length > MAX_ARG_STRING_CHARS) {
      throw new ConfigError(`entry ${index} is too long`, key);
    }
    // A bundle allowlist entry is matched against a directory name, never a
    // path: `n8n/../grafana` would be a way to smuggle a second bundle past an
    // allowlist that only meant to permit the first.
    if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
      throw new ConfigError(`entry ${index} must be a plain bundle name, not a path`, key);
    }
    return trimmed;
  });
}

/**
 * Reject any key this plugin does not understand.
 *
 * Runs before anything else, so the operator is told about the typo even when
 * the rest of the document is also wrong.
 */
function assertKnownKeys(raw: Record<string, unknown>): void {
  const allowed = new Set(settableConfigKeys());
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ConfigError(
        `unknown key. This plugin's configuration is closed; it accepts only: ${[
          ...allowed,
        ].join(", ")}`,
        key,
      );
    }
  }
}

function readRag(raw: unknown): RuntimeRagConfig {
  const fallback = DEFAULT_RUNTIME_CONFIG.rag;
  if (raw === undefined || raw === null) return { ...fallback };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("must be an object", "rag");
  }
  const record = raw as Record<string, unknown>;
  const allowed = ["enabled", "endpoint", "model", "secretRef", "topK", "weight"];
  const unknownKey = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknownKey) {
    throw new ConfigError(`accepts only: ${allowed.join(", ")}`, `rag.${unknownKey}`);
  }
  const enabled = record["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new ConfigError("must be a boolean", "rag.enabled");
  }
  const endpoint = sourceString(record, "endpoint", "rag.endpoint");
  const model = sourceString(record, "model", "rag.model");
  const turnedOn = enabled ?? fallback.enabled;
  // Enabled without the two things it needs is a configuration that cannot work, so
  // it is refused here rather than at the first search, where it would look like the
  // corpus had stopped answering well.
  if (turnedOn && (!endpoint || !model)) {
    throw new ConfigError(
      "requires both `endpoint` and `model` when enabled; without them there is nothing to query",
      "rag",
    );
  }
  if (endpoint && !/^https?:/.test(endpoint)) {
    throw new ConfigError("must be an http(s) URL", "rag.endpoint");
  }
  const topK = record["topK"];
  if (topK !== undefined) {
    if (typeof topK !== "number" || !Number.isFinite(topK)) {
      throw new ConfigError("must be a finite number", "rag.topK");
    }
    if (topK < MIN_RAG_TOP_K || topK > MAX_RAG_TOP_K) {
      throw new ConfigError(`must be between ${MIN_RAG_TOP_K} and ${MAX_RAG_TOP_K}`, "rag.topK");
    }
  }
  const weight = record["weight"];
  if (weight !== undefined) {
    if (typeof weight !== "number" || !Number.isFinite(weight)) {
      throw new ConfigError("must be a finite number", "rag.weight");
    }
    if (weight < MIN_RAG_WEIGHT || weight > MAX_RAG_WEIGHT) {
      throw new ConfigError(`must be between ${MIN_RAG_WEIGHT} and ${MAX_RAG_WEIGHT}`, "rag.weight");
    }
  }
  return {
    enabled: turnedOn,
    endpoint,
    model,
    secretRef: sourceString(record, "secretRef", "rag.secretRef"),
    topK: Math.floor(topK ?? fallback.topK),
    weight: weight ?? fallback.weight,
  };
}

function readRefresh(raw: unknown): RuntimeRefreshConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_RUNTIME_CONFIG.refresh };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("must be an object", "refresh");
  }
  const record = raw as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => key !== "enabled" && key !== "maxAgeDays");
  if (unknownKey) {
    throw new ConfigError("accepts only `enabled` and `maxAgeDays`", `refresh.${unknownKey}`);
  }
  const enabled = record["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new ConfigError("must be a boolean", "refresh.enabled");
  }
  const maxAgeDays = record["maxAgeDays"];
  if (maxAgeDays !== undefined) {
    if (typeof maxAgeDays !== "number" || !Number.isFinite(maxAgeDays)) {
      throw new ConfigError("must be a finite number", "refresh.maxAgeDays");
    }
    if (maxAgeDays < MIN_REFRESH_MAX_AGE_DAYS || maxAgeDays > MAX_REFRESH_MAX_AGE_DAYS) {
      throw new ConfigError(
        `must be between ${MIN_REFRESH_MAX_AGE_DAYS} and ${MAX_REFRESH_MAX_AGE_DAYS}`,
        "refresh.maxAgeDays",
      );
    }
  }
  return {
    enabled: enabled ?? DEFAULT_RUNTIME_CONFIG.refresh.enabled,
    maxAgeDays: Math.floor(maxAgeDays ?? DEFAULT_RUNTIME_CONFIG.refresh.maxAgeDays),
  };
}

function sourceString(
  record: Record<string, unknown>,
  key: string,
  field: string,
  fallback = "",
): string {
  const value = record[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new ConfigError("must be a string", field);
  const trimmed = value.trim();
  if (trimmed.length > MAX_ARG_STRING_CHARS) throw new ConfigError("is too long", field);
  return trimmed;
}

function sourceStringArray(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string[] {
  const value = record[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ConfigError("must be an array of strings", field);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ConfigError(`entry ${index} must be a non-empty string`, field);
    }
    const trimmed = entry.trim();
    if (trimmed.length > MAX_ARG_STRING_CHARS) {
      throw new ConfigError(`entry ${index} is too long`, field);
    }
    return trimmed;
  });
}

/**
 * The registry, strictly.
 *
 * Strict here rather than lenient like the form reader, because this is the half a
 * runner acts on: a source missing its repository would otherwise be written into a
 * request file, silently fetched as nothing, and reported as a corpus that simply
 * has fewer pages. Naming the offending entry is the difference between a typo and a
 * mystery.
 */
function readSources(raw: unknown): RuntimeSourceDeclaration[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConfigError("must be an array", "sources");
  if (raw.length > MAX_SOURCES) {
    throw new ConfigError(`must have at most ${MAX_SOURCES} entries`, "sources");
  }

  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const field = `sources[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError("must be an object", field);
    }
    const record = entry as Record<string, unknown>;

    const id = sourceString(record, "id", `${field}.id`);
    if (!id) throw new ConfigError("is required", `${field}.id`);
    // The id becomes a directory name in the corpus and a bundle name in an
    // allowlist, so it is a plain name for the same reason an allowlist entry is.
    if (id.includes("/") || id.includes("\\") || id.includes("..")) {
      throw new ConfigError("must be a plain bundle name, not a path", `${field}.id`);
    }
    if (seen.has(id)) {
      throw new ConfigError(`duplicate id "${id}"; two sources cannot write one bundle`, `${field}.id`);
    }
    seen.add(id);

    const kind = sourceString(record, "kind", `${field}.kind`);
    if (!SOURCE_KINDS.includes(kind as SourceKind)) {
      throw new ConfigError(`must be one of: ${SOURCE_KINDS.join(", ")}`, `${field}.kind`);
    }
    const convert = sourceString(record, "convert", `${field}.convert`, "auto");
    if (!SOURCE_CONVERSIONS.includes(convert as SourceConversion)) {
      throw new ConfigError(`must be one of: ${SOURCE_CONVERSIONS.join(", ")}`, `${field}.convert`);
    }

    const repo = sourceString(record, "repo", `${field}.repo`);
    const url = sourceString(record, "url", `${field}.url`);
    if ((kind === "git" || kind === "wiki") && !repo) {
      throw new ConfigError(`is required for a ${kind} source`, `${field}.repo`);
    }
    if (kind === "llms" && !url) {
      throw new ConfigError("is required for an llms source", `${field}.url`);
    }

    return {
      id,
      title: sourceString(record, "title", `${field}.title`, id),
      kind: kind as SourceKind,
      repo,
      url,
      ref: sourceString(record, "ref", `${field}.ref`),
      path: sourceString(record, "path", `${field}.path`),
      convert: convert as SourceConversion,
      include: sourceStringArray(record, "include", `${field}.include`),
      exclude: sourceStringArray(record, "exclude", `${field}.exclude`),
      tags: sourceStringArray(record, "tags", `${field}.tags`),
    };
  });
}

/**
 * Normalize raw host config into {@link RuntimeConfig}.
 *
 * Throws {@link ConfigError} naming the offending field. The caller surfaces
 * that to the operator rather than serving a half-configured corpus: a config
 * that cannot be understood is a config that must not answer a question.
 */
export function normalizeConfig(
  input: unknown,
  options: { home?: string } = {},
): RuntimeConfig {
  const home = options.home ?? os.homedir();
  if (input === undefined || input === null) {
    // The default root is stored with a `~`, so even the "no config at all"
    // path has to expand it — otherwise a caller that never configured the
    // plugin would be handed a literal tilde as a filesystem path.
    return { ...DEFAULT_RUNTIME_CONFIG };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigError("must be an object", "$");
  }
  const raw = input as Record<string, unknown>;
  assertKnownKeys(raw);

  // An empty root is a *state*, not an error: it means this organization has no
  // corpus, and every tool refuses. Anything else must be an absolute path — a
  // relative one would resolve against the worker's working directory, which is the
  // host's choice and not something an operator can predict.
  const rawRootValue = raw["corpusRoot"];
  if (rawRootValue !== undefined && rawRootValue !== null && typeof rawRootValue !== "string") {
    throw new ConfigError("must be a string", "corpusRoot");
  }
  const rawRoot = typeof rawRootValue === "string" ? rawRootValue.trim() : "";
  const corpusRoot = rawRoot.length === 0 ? "" : path.normalize(expandHome(rawRoot, home));
  if (corpusRoot.length > 0 && !path.isAbsolute(corpusRoot)) {
    throw new ConfigError("must be an absolute path, or start with `~`", "corpusRoot");
  }

  return {
    enabled: readBool(raw, "enabled", DEFAULT_RUNTIME_CONFIG.enabled),
    refresh: readRefresh(raw["refresh"]),
    sources: readSources(raw["sources"]),
    rag: readRag(raw["rag"]),
    corpusRoot,
    allowedBundles: readStringArray(raw, "allowedBundles"),
    maxResults: readNumber(
      raw,
      "maxResults",
      DEFAULT_RUNTIME_CONFIG.maxResults,
      MIN_MAX_RESULTS,
      MAX_MAX_RESULTS,
    ),
    maxDocChars: readNumber(
      raw,
      "maxDocChars",
      DEFAULT_RUNTIME_CONFIG.maxDocChars,
      MIN_MAX_DOC_CHARS,
      MAX_MAX_DOC_CHARS,
    ),
  };
}
