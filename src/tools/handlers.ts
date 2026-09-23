/**
 * The four tool behaviours, as plain functions.
 *
 * Kept out of `worker.ts` so they can be tested without importing the worker,
 * which calls `runWorker()` at module load and would try to open a host RPC
 * channel. The worker's job is only to validate arguments, read the company's
 * config, and hand the result back; everything an agent actually experiences is
 * decided here.
 *
 * ## Result shape
 *
 * Every tool returns both `content` — the text the model reads — and `data`, the
 * same information structured. The agent gets prose it can reason over; the tool
 * gateway, a transcript viewer, or a future UI gets fields it can index without
 * re-parsing markdown.
 */

import {
  DEFAULT_SEARCH_LIMIT,
  truncationMarker,
} from "../constants.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { browseCorpus } from "../corpus/browse.js";
import { searchConcepts } from "../corpus/search.js";
import { CorpusUnavailable, readConcept, type CorpusStatus, type CorpusStore } from "../corpus/store.js";
import { stringArg, numberArg } from "./validate.js";

/**
 * Structural match for the SDK's `ToolResult`; avoids importing it at runtime.
 *
 * `content` is optional because a failure carries `error` instead — the same
 * shape the SDK declares.
 */
export interface ToolOutcome {
  content?: string;
  data?: unknown;
  error?: string;
}

/** Collapse whitespace so a multi-line vendor page cannot inflate a result. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * `search_docs`.
 *
 * The configured `maxResults` is applied here, not trusted from the argument:
 * an agent that asks for 500 results gets the operator's ceiling instead, which
 * is the difference between a search and a corpus dump.
 */
export async function searchDocs(
  store: CorpusStore,
  config: RuntimeConfig,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const query = stringArg(args, "query");
  if (query === null) {
    return { error: 'Parameter "query" is required and must be a non-empty string' };
  }

  const bundle = stringArg(args, "bundle");
  const type = stringArg(args, "type");
  const requested = numberArg(args, "limit") ?? DEFAULT_SEARCH_LIMIT;
  const limit = Math.max(1, Math.min(requested, config.maxResults));

  const allowed = config.allowedBundles;
  if (bundle !== null && allowed.length > 0 && !allowed.includes(bundle)) {
    return {
      content: `The bundle "${bundle}" is not available on this instance. Available bundles: ${allowed.join(", ")}.`,
      data: { mode: "all", count: 0, considered: 0, more: false, results: [], bundleAllowed: false },
    };
  }

  let index;
  try {
    index = await store.load(config.corpusRoot);
  } catch (error) {
    const message =
      error instanceof CorpusUnavailable
        ? error.message
        : `the corpus could not be indexed: ${String(error)}`;
    return { error: `Documentation search is unavailable. ${message}` };
  }

  const outcome = searchConcepts(index, query, {
    bundle: bundle ?? undefined,
    type: type ?? undefined,
    limit,
    allowedBundles: allowed,
  });

  if (outcome.hits.length === 0) {
    const scope =
      bundle !== null ? ` in bundle "${bundle}"` : "";
    return {
      content: `No documentation matched "${query}"${scope}. ${outcome.considered} concept(s) were searched. Try fewer or different terms, or call list_docs to browse.`,
      data: {
        mode: outcome.mode,
        count: 0,
        considered: outcome.considered,
        more: false,
        results: [],
        bundleAllowed: true,
      },
    };
  }

  const lines: string[] = [];
  lines.push(
    `${outcome.hits.length} result(s) for "${query}"${
      bundle !== null ? ` in ${bundle}` : ""
    } — matched on ${outcome.mode === "all" ? "ALL" : "ANY"} terms, ranked by field. Corpus: ${index.root}`,
  );
  lines.push("");

  outcome.hits.forEach((hit, position) => {
    lines.push(`${position + 1}. ${hit.title}${hit.type ? ` [${hit.type}]` : ""}`);
    lines.push(`   concept_id: ${hit.conceptId}`);
    lines.push(`   bundle: ${hit.bundle} · score: ${hit.score}`);
    if (hit.heading) lines.push(`   section: ${hit.heading}`);
    if (hit.snippet) lines.push(`   ${oneLine(hit.snippet)}`);
    const meta: string[] = [];
    if (hit.resource) meta.push(`resource: ${hit.resource}`);
    if (hit.timestamp) meta.push(`captured: ${hit.timestamp}`);
    if (meta.length > 0) lines.push(`   ${meta.join(" · ")}`);
    lines.push("");
  });
  lines.push("Next: read_doc with the concept_id you want in full.");

  return {
    content: lines.join("\n"),
    data: {
      mode: outcome.mode,
      count: outcome.hits.length,
      considered: outcome.considered,
      more: outcome.more,
      results: outcome.hits,
      bundleAllowed: true,
    },
  };
}

/**
 * `read_doc`.
 *
 * The body is truncated at the operator's cap and the truncation is *stated in
 * the returned text*: an unbounded tool result can exceed a context window and
 * evict the conversation it was meant to inform, and a silent cut is worse than
 * a stated one because the model cannot tell it is missing anything.
 */
export async function readDoc(
  store: CorpusStore,
  config: RuntimeConfig,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  // `store` is accepted so all four handlers share one call signature, and is
  // deliberately unused: this tool reads the real file from disk rather than
  // serving the index's capped prefix, because a reader that returned the prefix
  // would silently cut off long pages while claiming to return the document.
  void store;
  const conceptId = stringArg(args, "concept_id");
  if (conceptId === null) {
    return { error: 'Parameter "concept_id" is required and must be a non-empty string' };
  }

  const read = await readConcept(config.corpusRoot, conceptId, {
    maxChars: config.maxDocChars,
  });

  if (!read.ok) {
    // A missing or refused path is a clean, named failure — never a throw. A
    // tool that rejects its promise gives the agent a stack trace where it
    // needed a sentence.
    return {
      error:
        read.code === "not_found"
          ? `No documentation concept at "${conceptId}". ${read.message}`
          : read.code === "refused"
            ? `Refused "${conceptId}": ${read.message}`
            : `Could not read "${conceptId}": ${read.message}`,
      data: { conceptId, found: false, reason: read.code },
    };
  }

  const concept = read.concept;
  const header: string[] = [];
  header.push(`# ${concept.title}`);
  header.push(`concept_id: ${concept.conceptId}`);
  const meta: string[] = [`bundle: ${concept.bundle}`];
  if (concept.type) meta.push(`type: ${concept.type}`);
  if (concept.tags.length > 0) meta.push(`tags: ${concept.tags.join(", ")}`);
  if (concept.timestamp) meta.push(`captured: ${concept.timestamp}`);
  if (concept.resource) meta.push(`resource: ${concept.resource}`);
  header.push(meta.join(" · "));
  if (concept.frontmatterError) {
    header.push(
      `note: this concept's frontmatter did not fully parse (${concept.frontmatterError}); the body below is unaffected`,
    );
  }
  header.push("");
  header.push("---");
  header.push("");

  const marker = concept.truncated
    ? truncationMarker(concept.body.length, concept.totalChars)
    : "";

  return {
    content: `${header.join("\n")}${concept.body}${marker}`,
    data: {
      concept_id: concept.conceptId,
      bundle: concept.bundle,
      title: concept.title,
      type: concept.type,
      description: concept.description,
      tags: concept.tags,
      timestamp: concept.timestamp,
      resource: concept.resource,
      frontmatter: concept.frontmatter,
      body: concept.body,
      truncated: concept.truncated,
      totalChars: concept.totalChars,
      frontmatterError: concept.frontmatterError,
    },
  };
}

/** `list_docs` — progressive disclosure over the corpus tree. */
export async function listDocs(
  store: CorpusStore,
  config: RuntimeConfig,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const bundle = stringArg(args, "bundle");
  const path = stringArg(args, "path");

  let index;
  try {
    index = await store.load(config.corpusRoot);
  } catch (error) {
    const message =
      error instanceof CorpusUnavailable
        ? error.message
        : `the corpus could not be indexed: ${String(error)}`;
    return { error: `Documentation browsing is unavailable. ${message}` };
  }

  let result;
  try {
    result = await browseCorpus(index, config.corpusRoot, {
      bundle: bundle ?? undefined,
      path: path ?? undefined,
      allowedBundles: config.allowedBundles,
      maxChars: config.maxDocChars,
    });
  } catch (error) {
    // `PathRefusal` reaches here for anything that leaves the corpus root. It is
    // reported, never read.
    return {
      error: `Refused "${path ?? bundle ?? ""}": ${
        error instanceof Error ? error.message : "the path was refused"
      }`,
      data: { refused: true },
    };
  }

  if (result.kind === "index" || result.kind === "document") {
    const marker =
      result.truncated && result.body !== null
        ? truncationMarker(result.body.length, result.totalChars)
        : "";
    const lines: string[] = [];
    lines.push(result.kind === "index" ? `Index: ${result.conceptId}` : `Page: ${result.conceptId}`);
    if (result.frontmatter && Object.keys(result.frontmatter).length > 0) {
      lines.push(`frontmatter: ${JSON.stringify(result.frontmatter)}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
    return {
      content: `${lines.join("\n")}${result.body ?? ""}${marker}`,
      data: {
        kind: result.kind,
        bundle: result.bundle,
        path: result.path,
        concept_id: result.conceptId,
        frontmatter: result.frontmatter,
        body: result.body,
        truncated: result.truncated,
        totalChars: result.totalChars,
      },
    };
  }

  const lines: string[] = [];
  const where = result.bundle === null ? "the corpus root" : `${result.bundle}${result.path ? `/${result.path}` : ""}`;
  if (result.note) lines.push(`Note: ${result.note}`);
  lines.push(`Listing of ${where} — ${result.total} entr${result.total === 1 ? "y" : "ies"}`);
  lines.push("");

  if (result.directories.length > 0) {
    lines.push("Directories:");
    for (const entry of result.directories) {
      lines.push(`  ${entry.conceptId} (${entry.conceptCount ?? 0} concepts)`);
    }
    lines.push("");
  }
  if (result.pages.length > 0) {
    lines.push("Pages:");
    for (const entry of result.pages) {
      const description = entry.description ? ` — ${oneLine(entry.description).slice(0, 160)}` : "";
      const type = entry.type ? ` [${entry.type}]` : "";
      lines.push(`  ${entry.conceptId}${type} — ${entry.title}${description}`);
    }
    lines.push("");
  }
  if (result.truncatedEntries > 0) {
    lines.push(
      `… ${result.truncatedEntries} more entr${result.truncatedEntries === 1 ? "y" : "ies"} not shown; narrow the path.`,
    );
  }
  if (result.directories.length === 0 && result.pages.length === 0 && !result.note) {
    lines.push("This directory has no markdown pages or subdirectories.");
  }

  return {
    content: lines.join("\n"),
    data: {
      kind: "listing",
      bundle: result.bundle,
      path: result.path,
      directories: result.directories,
      pages: result.pages,
      total: result.total,
      truncated: result.truncatedEntries > 0,
      truncatedEntries: result.truncatedEntries,
      note: result.note,
    },
  };
}

/**
 * `sources`.
 *
 * A snapshot must be able to state its own age. Without the oldest and newest
 * capture timestamps, an agent answers from documentation that may describe a
 * version nobody runs any more, and the answer reads exactly like a current one.
 * Reporting the age is what lets the answer be qualified instead.
 */
export async function sources(
  store: CorpusStore,
  config: RuntimeConfig,
  options: { now?: number } = {},
): Promise<ToolOutcome> {
  const status = await store.describe(config.corpusRoot, options);

  const lines: string[] = [];
  lines.push(`Corpus root: ${status.root}`);
  if (!status.exists) {
    lines.push(`Status: unavailable — ${status.error ?? "the corpus could not be read"}`);
    return {
      content: lines.join("\n"),
      data: { ...status, available: false },
    };
  }

  lines.push(`Bundles: ${status.bundles.length} · concepts: ${status.totalConcepts}`);
  lines.push("");
  for (const bundle of status.bundles) {
    const newest = bundle.newestTimestamp ? ` · newest ${bundle.newestTimestamp}` : "";
    lines.push(`  ${bundle.name}: ${bundle.conceptCount} concepts${newest}`);
  }
  lines.push("");
  lines.push(`Oldest capture: ${status.oldestTimestamp ?? "unknown"}`);
  lines.push(`Newest capture: ${status.newestTimestamp ?? "unknown"}`);
  lines.push(
    status.ageDays === null
      ? "Corpus age: unknown (no valid timestamps in frontmatter)"
      : `Corpus age: ${status.ageDays} day(s) since the newest capture${
          status.stale ? " — STALE, these docs may describe an older version" : ""
        }`,
  );
  if (status.manifest) {
    lines.push(
      `Build manifest (${status.manifestPath}): ${JSON.stringify(status.manifest).slice(0, 2_000)}`,
    );
  } else if (status.manifestPath) {
    lines.push(`Build manifest (${status.manifestPath}) could not be parsed.`);
  }
  if (status.skipped > 0) {
    lines.push(`Skipped: ${status.skipped} file(s) could not be read or were excluded.`);
  }

  return {
    content: lines.join("\n"),
    data: {
      available: true,
      corpusRoot: status.root,
      bundles: status.bundles,
      totalConcepts: status.totalConcepts,
      oldestTimestamp: status.oldestTimestamp,
      newestTimestamp: status.newestTimestamp,
      ageDays: status.ageDays,
      stale: status.stale,
      manifest: status.manifest,
      manifestPath: status.manifestPath,
      skipped: status.skipped,
    },
  };
}

/** The shape the settings page consumes; a subset of {@link CorpusStatus}. */
export interface StatusPayload {
  root: string;
  exists: boolean;
  enabled: boolean;
  totalConcepts: number;
  bundleCount: number;
  bundles: Array<{ name: string; conceptCount: number; newestTimestamp: string | null }>;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
  ageDays: number | null;
  stale: boolean;
  allowedBundles: string[];
  error: string | null;
}

/** Build the status payload for the settings page. */
export function statusPayload(
  status: CorpusStatus,
  config: RuntimeConfig,
  enabled: boolean,
): StatusPayload {
  return {
    root: status.root,
    exists: status.exists,
    enabled,
    totalConcepts: status.totalConcepts,
    bundleCount: status.bundles.length,
    bundles: status.bundles.map((bundle) => ({
      name: bundle.name,
      conceptCount: bundle.conceptCount,
      newestTimestamp: bundle.newestTimestamp,
    })),
    oldestTimestamp: status.oldestTimestamp,
    newestTimestamp: status.newestTimestamp,
    ageDays: status.ageDays,
    stale: status.stale,
    allowedBundles: config.allowedBundles,
    error: status.error,
  };
}
