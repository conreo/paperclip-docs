/**
 * Reading an in-progress vector-index build, so the settings page can show it.
 *
 * ## Where the number comes from
 *
 * The plugin cannot build the index — it cannot spawn a process — so the indexer
 * runs on the host. It is resumable, and to be resumable it keeps a journal beside
 * the corpus: `embeddings.ids.jsonl`, one `concept_id` per line, appended as each
 * vector is written to `embeddings.bin.partial`. Both are written by the indexer
 * itself, and the final `embeddings.json` + `embeddings.bin` appear only when the
 * whole corpus is done.
 *
 * That journal is the progress signal, and it already exists — no new protocol,
 * no request to poll. Before this, the operator's only views were "no index" and
 * "index", with an hour of silence in between, and a killed build looked exactly
 * like a build that had never started.
 *
 * It is a *hint*, not a contract: a journal can be stale (the indexer was killed),
 * so freshness decides whether it counts as running, and a stale journal with no
 * index is reported as interrupted rather than as progress.
 *
 * The arithmetic is pure so it can be tested without a filesystem; the worker does
 * the two reads and hands the numbers here.
 */

/** How long a journal may go unwritten before the build is presumed dead. */
export const BUILD_ACTIVE_WINDOW_MS = 120_000;

/** The indexer's resumable journal, beside the corpus root. */
export const EMBEDDINGS_JOURNAL = "embeddings.ids.jsonl";

/** The matrix being appended to, beside the corpus root. */
export const EMBEDDINGS_PARTIAL = "embeddings.bin.partial";

export interface BuildProgress {
  /** The journal was written recently, so a build is probably running now. */
  active: boolean;
  /** Concepts journaled so far. */
  done: number;
  /** Concepts in the corpus, or 0 when that is not known. */
  total: number;
  /** Whole percent, clamped to 0–100. */
  percent: number;
  /** When the journal was last written, ISO, or null when there is no journal. */
  updatedAt: string | null;
  /** A journal that stopped without producing an index: a build that was killed. */
  interrupted: boolean;
}

/**
 * Shape the journal into something a progress bar can render.
 *
 * Returns null when there is nothing to say: no journal, or an empty one, means no
 * build has been attempted since the last successful one.
 */
export function describeBuild(input: {
  done: number;
  total: number;
  updatedAtMs: number | null;
  hasIndex: boolean;
  nowMs?: number;
  windowMs?: number;
}): BuildProgress | null {
  const { done, total, updatedAtMs, hasIndex } = input;
  if (updatedAtMs === null) return null;
  if (!Number.isFinite(done) || done <= 0) return null;

  const now = input.nowMs ?? Date.now();
  const windowMs = input.windowMs ?? BUILD_ACTIVE_WINDOW_MS;
  const active = now - updatedAtMs <= windowMs;
  const known = Number.isFinite(total) && total > 0;
  const percent = known ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;

  return {
    active,
    done,
    total: known ? total : 0,
    percent,
    updatedAt: new Date(updatedAtMs).toISOString(),
    interrupted: !active && known && done < total && !hasIndex,
  };
}

/** Count the lines of a journal, tolerating a trailing newline or a torn last line. */
export function countJournalEntries(contents: string): number {
  let entries = 0;
  for (const line of contents.split("\n")) {
    if (line.trim().length > 0) entries += 1;
  }
  return entries;
}

/** A one-line summary of a finished index, for the settings page. */
export function describeIndexLine(index: {
  count: number;
  dim: number;
  model: string;
  complete: boolean;
  builtAt: string;
}): string {
  const vectors = index.count.toLocaleString("en-US");
  const built = index.builtAt ? `, built ${index.builtAt}` : "";
  const partial = index.complete ? "" : " — covering only some bundles";
  return `${vectors} vectors of ${index.dim} dimensions, from ${index.model}${built}${partial}.`;
}
