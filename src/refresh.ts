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

import { MAX_ARG_STRING_CHARS, REQUEST_FILENAME, REQUESTS_FOLDER_KEY } from "./constants.js";
import type { RuntimeSourceDeclaration } from "./runtime-config.js";

/** The on-disk request the host runner reads. */
export interface RefreshRequest {
  /** Bumped when the shape changes; the runner refuses what it does not know. */
  schema: 1;
  requestedAt: string;
  /** Why this was written, for the runner's log and the operator's benefit. */
  reason: string;
  /** Where the built corpus belongs. */
  corpusRoot: string;
  /** The registry the operator declared for this company. */
  sources: RuntimeSourceDeclaration[];
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
  now: Date = new Date(),
): RefreshRequest {
  return {
    schema: 1,
    requestedAt: now.toISOString(),
    reason: reason.slice(0, 500),
    corpusRoot,
    // Copied, not referenced: this is serialized and handed to another process.
    sources: sources.map((source) => ({ ...source })),
  };
}

/**
 * The narrow slice of the host client this module needs.
 *
 * Structural rather than imported, so a test can pass a fake and so a host that
 * does not provide local folders produces a clear log line instead of a crash.
 */
export interface RequestWriter {
  /** The host's signature, which is positional. */
  writeTextAtomic(
    companyId: string,
    folderKey: string,
    relativePath: string,
    contents: string,
  ): Promise<unknown>;
}

export type RequestOutcome =
  | { written: true; path: string }
  | { written: false; skipped: string };

/**
 * Write the request, or explain why it could not be written.
 *
 * Never throws. A refresh request is an optimisation: failing to write one must not
 * fail the job, and must not be silent either — the operator is told, because a
 * refresh that never happens looks exactly like a refresh that is not needed.
 */
export async function writeRefreshRequest(
  writer: RequestWriter | undefined,
  companyId: string,
  request: RefreshRequest,
): Promise<RequestOutcome> {
  const contents = `${JSON.stringify(request, null, 2)}\n`;
  if (contents.length > MAX_ARG_STRING_CHARS * 64) {
    return { written: false, skipped: "the request is implausibly large; refusing to write it" };
  }
  if (!writer || typeof writer.writeTextAtomic !== "function") {
    return {
      written: false,
      skipped:
        `the host did not provide local folders, so a request cannot be written. ` +
        `Declare "${REQUESTS_FOLDER_KEY}" and point it at a directory the runner watches.`,
    };
  }
  try {
    await writer.writeTextAtomic(companyId, REQUESTS_FOLDER_KEY, REQUEST_FILENAME, contents);
    return { written: true, path: `${REQUESTS_FOLDER_KEY}/${REQUEST_FILENAME}` };
  } catch (error) {
    return { written: false, skipped: `the request could not be written: ${String(error)}` };
  }
}
