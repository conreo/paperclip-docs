/**
 * Refresh requests — how this plugin asks the host to rebuild the corpus.
 *
 * ## Why a request file and not a rebuild
 *
 * The plugin runtime offers no way to spawn a process, which I checked rather than
 * assumed: `PLUGIN_CAPABILITIES` has no `process.*`, no `shell`, no `exec`. So the
 * worker cannot run `git`, cannot run `pandoc`, and cannot embed a vector — and a
 * rebuild is not a thing it is able to do, whatever the design would prefer.
 *
 * What it *can* do is say what it needs. A request is written into a declared local
 * folder as JSON; a runner on the host (cron, systemd, a container) reads it, runs
 * the deterministic builder, and writes the corpus plus its manifest. The plugin
 * then reports what actually happened by reading that manifest.
 *
 * That split is deliberate beyond the runtime limit:
 *
 *   - **the corpus is a trust input.** An agent that can write it can change what
 *     every other agent believes. Here the agent can only *read* it; a request is a
 *     file an operator's runner chooses to honour.
 *   - **builds stay reproducible.** The runner is a script with pinned refs, not an
 *     agent run with a token and a timeout.
 *   - **no credentials in the worker.** The request names sources; it carries no
 *     keys and performs no fetch.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { MAX_ARG_STRING_CHARS, REQUEST_FILENAME, RESPONSE_FILENAME } from "./constants.js";
import type { RuntimeSourceDeclaration } from "./runtime-config.js";

/** Which half of the pipeline a request asks for. */
export type RequestMode = "okf" | "index" | "both" | "prune";

/** The embedding settings a request carries, when it is allowed to embed. */
export interface RequestEmbed {
  endpoint: string;
  model: string;
}

/** What a `prune` request asks the runner to delete. */
export interface RequestRemoval {
  bundles: string[];
}

/** The on-disk request the host runner reads. */
export interface RefreshRequest {
  /** Bumped when the shape changes; the runner refuses what it does not know. */
  schema: 1;
  requestedAt: string;
  /** Why this was written, for the runner's log and the operator's benefit. */
  reason: string;
  /** Where the built corpus belongs. */
  corpusRoot: string;
  /**
   * Which half of the pipeline to run.
   *
   * `index` rebuilds the vector index from the corpus already on disk and fetches
   * nothing — which is the point: an index has to be rebuildable after the sources
   * that built the corpus have moved, changed shape, or been removed. `prune` goes
   * further still: it deletes pages and their vectors, so it must not need the source
   * that produced them to exist at all.
   */
  mode: RequestMode;
  /** The registry the operator declared for this company. */
  sources: RuntimeSourceDeclaration[];
  /**
   * Present only when semantic retrieval is configured. A corpus rebuild replaces
   * the corpus directory, and the index lives inside it, so a `both` request is how
   * a rebuild avoids throwing the index away.
   */
  embed?: RequestEmbed;
  /** Present only for `prune`: what to delete. */
  remove?: RequestRemoval;
}

/**
 * Whether the corpus is old enough to ask for a rebuild.
 *
 * Reads the newest capture date out of the build manifest, not the file mtimes: a
 * `cp -r` or a restore from backup would make every file look new, and a rebuild
 * would then look unnecessary forever.
 */
export function corpusAgeDays(manifest: unknown, now: Date): number | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const builtAt = (manifest as { built_at?: unknown }).built_at;
  if (typeof builtAt !== "string") return null;
  const parsed = Date.parse(builtAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor((now.getTime() - parsed) / 86_400_000);
}

export interface RefreshDecision {
  request: boolean;
  reason: string;
}

/**
 * Decide whether to write a request.
 *
 * Returns the reason either way, so the settings page and the job log can say why
 * nothing happened — "already fresh" and "refresh is off" are different states and
 * an operator chasing a missing rebuild needs to tell them apart.
 */
export function shouldRequestRefresh(input: {
  refreshEnabled: boolean;
  maxAgeDays: number;
  ageDays: number | null;
  sources: RuntimeSourceDeclaration[];
  manifestError?: string | null;
}): RefreshDecision {
  if (!input.refreshEnabled) {
    return { request: false, reason: "refresh is off for this organization" };
  }
  if (input.sources.length === 0) {
    return { request: false, reason: "no sources are declared, so there is nothing to build" };
  }
  if (input.manifestError) {
    return { request: true, reason: `the build manifest could not be read: ${input.manifestError}` };
  }
  if (input.ageDays === null) {
    return { request: true, reason: "the corpus has no build manifest, so its age is unknown" };
  }
  if (input.ageDays >= input.maxAgeDays) {
    return { request: true, reason: `the corpus is ${input.ageDays} days old (limit ${input.maxAgeDays})` };
  }
  return { request: false, reason: `the corpus is ${input.ageDays} days old (limit ${input.maxAgeDays})` };
}

/** Build the payload. Pure, so the shape a runner depends on is testable. */
export function buildRefreshRequest(
  corpusRoot: string,
  sources: RuntimeSourceDeclaration[],
  reason: string,
  options: { mode?: RequestMode; embed?: RequestEmbed; remove?: RequestRemoval; now?: Date } = {},
): RefreshRequest {
  const mode: RequestMode = options.mode ?? (options.embed ? "both" : "okf");
  const request: RefreshRequest = {
    schema: 1,
    requestedAt: (options.now ?? new Date()).toISOString(),
    reason: reason.slice(0, 500),
    corpusRoot,
    mode,
    // Copied, not referenced: this is serialized and handed to another process.
    sources: sources.map((source) => ({ ...source })),
  };
  // Only a mode that embeds carries the settings: a request the runner would refuse
  // is worse than one that asks for less, and `okf` with an embed block is exactly
  // that ambiguity.
  if (options.embed && mode !== "okf") {
    request.embed = { endpoint: options.embed.endpoint, model: options.embed.model };
  }
  // Only a prune carries a removal. A deletion attached to a build request is the one
  // combination that could delete something nobody asked to delete.
  if (options.remove && mode === "prune" && options.remove.bundles.length > 0) {
    request.remove = { bundles: [...options.remove.bundles] };
  }
  return request;
}

export type RequestOutcome =
  | { written: true; path: string }
  | { written: false; skipped: string };

/**
 * Where a request goes: a sibling of the corpus, derived from it.
 *
 * ## Why nothing is configured for this
 *
 * The first version declared a `local.folders` folder for requests, which made
 * Paperclip ask the operator to choose a directory and show the plugin as "needs
 * attention" until they did. That was the wrong shape: an operator configuring a
 * filesystem path is a deployment detail leaking into a settings page, and the path
 * is already implied by where the corpus lives.
 *
 * A *sibling* of the corpus rather than a directory inside it, because the corpus is
 * replaced by a rename on every rebuild — anything written inside it would be
 * discarded, and this plugin does not write into the corpus at all.
 *
 * The runner derives the same path, so the two halves agree without either being
 * told what it is.
 */
export function requestsDirFor(corpusRoot: string): string {
  const trimmed = corpusRoot.replace(/[\\/]+$/, "");
  return `${trimmed}${REQUEST_SUFFIX}`;
}

/** `okf-bundles` → `okf-bundles.requests`. */
const REQUEST_SUFFIX = ".requests";

/**
 * Write the request, or explain why it could not be written.
 *
 * Never throws. A refresh request is an optimisation: failing to write one must not
 * fail the operator's action, and must not be silent either — a refresh that never
 * happens looks exactly like a refresh that is not needed. Written to a temporary
 * file and renamed, so a runner polling the directory never reads half a document.
 */
export async function writeRefreshRequest(
  corpusRoot: string,
  request: RefreshRequest,
): Promise<RequestOutcome> {
  const contents = `${JSON.stringify(request, null, 2)}\n`;
  if (contents.length > MAX_ARG_STRING_CHARS * 64) {
    return { written: false, skipped: "the request is implausibly large; refusing to write it" };
  }
  const dir = requestsDirFor(corpusRoot);
  const target = path.join(dir, REQUEST_FILENAME);
  try {
    await fs.mkdir(dir, { recursive: true });
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, contents, "utf8");
    await fs.rename(temporary, target);
    return { written: true, path: target };
  } catch (error) {
    return {
      written: false,
      skipped: `the request could not be written to ${target}: ${String(error)}`,
    };
  }
}

/** The runner's reply, when it has written one. Reported rather than guessed at. */
export async function readRefreshResponse(corpusRoot: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(path.join(requestsDirFor(corpusRoot), RESPONSE_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
