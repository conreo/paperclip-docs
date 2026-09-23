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
  DEFAULT_CORPUS_ROOT,
  DEFAULT_MAX_DOC_CHARS,
  DEFAULT_MAX_RESULTS,
  MAX_ARG_STRING_CHARS,
  MAX_MAX_DOC_CHARS,
  MAX_MAX_RESULTS,
  MIN_MAX_DOC_CHARS,
  MIN_MAX_RESULTS,
} from "./constants.js";
import { ConfigError, settableConfigKeys } from "./config.js";

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
}

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
  corpusRoot: expandHome(DEFAULT_CORPUS_ROOT),
  allowedBundles: [],
  maxResults: DEFAULT_MAX_RESULTS,
  maxDocChars: DEFAULT_MAX_DOC_CHARS,
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
    return { ...DEFAULT_RUNTIME_CONFIG, corpusRoot: expandHome(DEFAULT_CORPUS_ROOT, home) };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigError("must be an object", "$");
  }
  const raw = input as Record<string, unknown>;
  assertKnownKeys(raw);

  const rawRoot = readString(raw, "corpusRoot", DEFAULT_CORPUS_ROOT, 4_096);
  const corpusRoot = path.normalize(expandHome(rawRoot, home));
  if (!path.isAbsolute(corpusRoot)) {
    // A relative root would resolve against the worker's working directory,
    // which is the host's choice and not something an operator can predict.
    throw new ConfigError("must be an absolute path, or start with `~`", "corpusRoot");
  }

  return {
    enabled: readBool(raw, "enabled", DEFAULT_RUNTIME_CONFIG.enabled),
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
