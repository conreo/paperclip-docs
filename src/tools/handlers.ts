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
import { hitForConcept, searchConcepts, type SearchHit } from "../corpus/search.js";
import { blendWithKeyword } from "../rag.js";
import { CorpusUnavailable, readConcept, type CorpusStatus, type CorpusStore } from "../corpus/store.js";
import { permitsBundle } from "../config.js";
import { stringArg, numberArg } from "./validate.js";

/**
 * The refusal for an organization with no corpus of its own.
 *
 * Empty is a state, not a fallback: before this existed, an organization whose
 * configuration nobody had touched inherited the same corpus root as everyone else
 * and could read everything in it. Saying so plainly is better than an empty result,
 * which reads like a corpus that simply has nothing relevant.
 */
export function corpusUnconfigured(config: RuntimeConfig): ToolOutcome | null {
  if (config.corpusRoot.trim().length > 0) return null;
  return {
    error:
      "No documentation corpus is configured for this organization. An operator sets the corpus directory in Settings → Plugins → Docs; until then these tools refuse rather than serving another organization's corpus.",
  };
}

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
/**
 * The narrow slice of semantic retrieval this handler needs.
 *
 * Injected rather than imported so the handler stays free of HTTP, secrets and the
 * corpus root, and so a test can hand it a fixed ranking and assert the blend.
 */
export interface SemanticRetriever {
  rank(query: string): Promise<{ candidates: { conceptId: string; score: number }[]; note: string }>;
}

export async function searchDocs(
  store: CorpusStore,
  config: RuntimeConfig,
  args: Record<string, unknown>,
  semantic?: SemanticRetriever,
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
  if (bundle !== null && !permitsBundle(allowed, bundle)) {
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

  // Semantic retrieval, when the operator turned it on. It contributes candidates
  // rather than replacing the ranking: a page that says "single sign-on" and never
  // the letters SSO has no keyword score to be beaten by, and a page that matches
  // exactly should not be displaced by something merely similar.
  let hits = outcome.hits;
  let semanticNote = "";
  if (semantic) {
    const ranked = await semantic.rank(query);
    semanticNote = ranked.note;
    if (ranked.candidates.length > 0) {
      const byId = new Map(index.concepts.map((concept) => [concept.conceptId, concept]));
      const blended = blendWithKeyword(
        new Map(outcome.hits.map((hit) => [hit.conceptId, hit.score])),
        ranked.candidates,
        config.rag.weight,
      );
      hits = [...blended.entries()]
        .map(([conceptId, score]) => {
          const existing = outcome.hits.find((hit) => hit.conceptId === conceptId);
          if (existing) return { ...existing, score: Math.round(score * 100) / 100 };
          const concept = byId.get(conceptId);
          // A semantic-only candidate still has to obey the caller's bundle and type
          // filters: retrieval must not become a way around an allowlist.
          if (!concept) return null;
          if (bundle !== null && concept.bundle !== bundle) return null;
          if (type !== null && concept.type !== type) return null;
          return hitForConcept(concept, score, query);
        })
        .filter((hit): hit is SearchHit => hit !== null)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    }
  }

  if (hits.length === 0) {
    const scope =
      bundle !== null ? ` in bundle "${bundle}"` : "";
    return {
      content: `No documentation matched "${query}"${scope}. ${outcome.considered} concept(s) were searched. Try fewer or different terms, or call list_docs to browse.${semanticNote ? ` (${semanticNote})` : ""}`,
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
    `${hits.length} result(s) for "${query}"${
      bundle !== null ? ` in ${bundle}` : ""
    } — matched on ${outcome.mode === "all" ? "ALL" : "ANY"} terms, ranked by field. Corpus: ${index.root}`,
  );
  lines.push("");

  hits.forEach((hit, position) => {
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
      count: hits.length,
      considered: outcome.considered,
      more: outcome.more,
      results: hits,
      semantic: semanticNote || undefined,
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
  const unconfigured = corpusUnconfigured(config);
  if (unconfigured) return unconfigured;

  const conceptId = stringArg(args, "concept_id");
  if (conceptId === null) {
    return { error: 'Parameter "concept_id" is required and must be a non-empty string' };
  }

  // The allowlist is checked *here*, on the read path, and not only where a bundle
  // is discovered. `search_docs` and `list_docs` filter their output, which is what
  // makes a bundle undiscoverable — but a caller who has seen the id can name it, so
  // filtering on discovery alone is a boundary an agent steps around with one guess.
  // For a single-tenant install that is an inconsistency; for a multi-tenant one it
  // is a cross-tenant read, and `allowedBundles` is the only content control this
  // plugin has. Checked before the file is read rather than after, so an ungranted
  // document is never opened.
  const requestedBundle = conceptId.split(/[\\/]+/).filter((part) => part.length > 0)[0] ?? "";
  if (!permitsBundle(config.allowedBundles, requestedBundle)) {
    return {
      error:
        `The bundle "${requestedBundle}" is not available on this instance. ` +
        `Available bundles: ${config.allowedBundles.join(", ")}.`,
      data: { concept_id: conceptId, found: false, reason: "bundle_not_allowed" },
    };
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
  const unconfigured = corpusUnconfigured(config);
  if (unconfigured) return unconfigured;
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
  const unconfigured = corpusUnconfigured(config);
  if (unconfigured) return unconfigured;

  const status = await store.describe(config.corpusRoot, options);

  const lines: string[] = [];
  // Deliberately *not* the corpus path. This was the opening line — "Corpus root: …"
  // — and that one line is how an agent with a shell on the host learned where the
  // index, the pending request file and the embedding endpoint live, and then did the
  // retrieval by hand instead of calling `search_docs`. An agent needs the snapshot's
  // age and what is in it; the deployment's paths are the operator's business.
  if (!status.exists) {
    lines.push(`Status: unavailable — ${status.error ?? "the corpus could not be read"}`);
    return {
      content: lines.join("\n"),
      // Not `...status`: the status carries the root, the manifest path and the
      // per-bundle paths, and an unavailable corpus is exactly when an agent starts
      // looking around for itself.
      data: { available: false, error: status.error },
    };
  }

  // The agent-facing inventory respects the allowlist; the *settings page* does not,
  // and that difference is deliberate. An operator configuring `allowedBundles` has
  // to see every bundle in order to decide what to grant, so `statusPayload` reports
  // the whole corpus. An agent does not: telling it that `beta` holds 3 concepts and
  // then refusing to read them is a boundary that announces itself and then refuses,
  // which reads as a fault rather than as policy.
  const visible = status.bundles.filter((bundle) =>
    permitsBundle(config.allowedBundles, bundle.name),
  );
  const visibleConcepts = visible.reduce((total, bundle) => total + bundle.conceptCount, 0);

  lines.push(`Bundles: ${visible.length} · concepts: ${visibleConcepts}`);
  lines.push("");
  for (const bundle of visible) {
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
    // The manifest's contents are provenance an agent can legitimately use — when the
    // corpus was built, from what. Its *path* is not: it names a directory on the
    // host, and the same directory holds the index and the runner's request folder.
    lines.push(`Build manifest: ${JSON.stringify(status.manifest).slice(0, 2_000)}`);
  } else if (status.manifestPath) {
    lines.push("Build manifest: present but could not be parsed.");
  }
  if (status.skipped > 0) {
    lines.push(`Skipped: ${status.skipped} file(s) could not be read or were excluded.`);
  }

  return {
    content: lines.join("\n"),
    data: {
      available: true,
      // No `corpusRoot` and no `manifestPath`. Both are host paths, and the settings
      // page gets them from its own data handler — the one surface that legitimately
      // needs to know where the corpus is.
      bundles: visible,
      totalConcepts: visibleConcepts,
      allowedBundles: config.allowedBundles,
      oldestTimestamp: status.oldestTimestamp,
      newestTimestamp: status.newestTimestamp,
      ageDays: status.ageDays,
      stale: status.stale,
      manifest: status.manifest,
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
