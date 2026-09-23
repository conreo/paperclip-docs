/**
 * Ranking a documentation search.
 *
 * ## Why field weighting, and why these weights
 *
 * A flat "does the text contain the words" match ranks a page that mentions a
 * topic in passing above the page *about* that topic. The corpus makes this
 * concrete: nearly every nextcloud concept's description ends in the same
 * breadcrumb, and a body can be eight thousand words. So a match is scored by
 * *where* it lands — title, then tags, then description, then headings, then
 * body — with the weights in `constants.ts`. The exact numbers are a judgement;
 * the ordering is the part that matters, and `tests/search.spec.ts` pins it.
 *
 * ## AND first, OR as a fallback
 *
 * Requiring every term is what makes a multi-word query precise. But a query
 * with one word that does not exist ("kubernetes" in a corpus that has none)
 * would then return nothing at all, which reads as "the corpus is empty" rather
 * than "no exact match". So an empty AND result is retried as ANY, and the
 * outcome reports which mode produced it. The agent — and the operator reading a
 * transcript — can tell an exact answer from a loose one.
 */

import { FIELD_WEIGHTS, MAX_QUERY_TERMS, PHRASE_TITLE_BONUS, SNIPPET_CHARS } from "../constants.js";
import type { ConceptRecord, CorpusIndex } from "./store.js";

export interface SearchHit {
  bundle: string;
  conceptId: string;
  title: string;
  type: string;
  /** The heading that best matches the query, or the first heading. */
  heading: string;
  snippet: string;
  resource: string | null;
  timestamp: string | null;
  score: number;
}

export interface SearchOutcome {
  /** `all` when every term matched, `any` when the fallback produced the hits. */
  mode: "all" | "any";
  hits: SearchHit[];
  /** Concepts that passed the bundle/type filters, before ranking. */
  considered: number;
  /** True when more hits existed than `limit` allowed. */
  more: boolean;
}

export interface SearchOptions {
  bundle?: string;
  type?: string;
  limit: number;
  /** Bundle names the operator allows; empty means every bundle. */
  allowedBundles: readonly string[];
}

/**
 * Split a query into comparable terms.
 *
 * Unicode-aware, so a query in a non-Latin script tokenises rather than
 * collapsing to nothing. Single characters are dropped: they match almost every
 * document, which makes an AND query impossible and an OR query useless.
 */
export function tokenize(query: string): string[] {
  const matches = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of matches) {
    if (match.length < 2) continue;
    if (seen.has(match)) continue;
    seen.add(match);
    terms.push(match);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  return terms;
}

/** How many times `term` occurs in `haystack`, capped so one word cannot dominate. */
function occurrences(haystack: string, term: string): number {
  if (haystack.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(term, from);
    if (at === -1) return count;
    count += 1;
    if (count >= 4) return count;
    from = at + term.length;
  }
}

interface FieldText {
  weight: number;
  text: string;
}

function fieldsOf(record: ConceptRecord): FieldText[] {
  return [
    { weight: FIELD_WEIGHTS.title, text: record.titleLower },
    { weight: FIELD_WEIGHTS.tags, text: record.tagsLower },
    { weight: FIELD_WEIGHTS.description, text: record.descriptionLower },
    { weight: FIELD_WEIGHTS.headings, text: record.headingsLower },
    { weight: FIELD_WEIGHTS.body, text: record.bodyLower },
  ];
}

interface Scored {
  record: ConceptRecord;
  score: number;
  missing: string[];
}

function scoreRecord(record: ConceptRecord, terms: readonly string[], phrase: string): Scored {
  const fields = fieldsOf(record);
  let score = 0;
  const missing: string[] = [];

  for (const term of terms) {
    let termScore = 0;
    for (const field of fields) {
      const count = occurrences(field.text, term);
      if (count === 0) continue;
      // A repeated term is mildly stronger evidence, but only mildly: a page
      // that says "webhook" forty times is not forty times more relevant.
      termScore += field.weight * (1 + Math.min(count - 1, 3) * 0.25);
    }
    if (termScore === 0) missing.push(term);
    score += termScore;
  }

  // The whole query in the title, not just its parts.
  if (phrase.length > 0 && record.titleLower.includes(phrase)) {
    score += PHRASE_TITLE_BONUS;
  }

  return { record, score, missing };
}

/** Collapse whitespace and hard-bound the result. */
function clampSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > SNIPPET_CHARS ? collapsed.slice(0, SNIPPET_CHARS) : collapsed;
}

/**
 * A window of body text around the first query match.
 *
 * When nothing matches the body, the first `SNIPPET_CHARS` characters are shown:
 * a result with no snippet at all is much harder to judge than one that shows
 * the opening line.
 */
function buildSnippet(body: string, terms: readonly string[]): string {
  if (body.length === 0) return "";
  const lower = body.toLowerCase();

  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }

  if (at === -1) return clampSnippet(body.slice(0, SNIPPET_CHARS));
  // Centre the window: half before the match, half after. The leading ellipsis
  // is the reader's signal that the sentence started earlier.
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 4));
  const window = body.slice(start, start + SNIPPET_CHARS);
  const prefix = start > 0 ? "…" : "";
  return clampSnippet(`${prefix}${window}`);
}

/**
 * The heading that best explains why this document matched.
 *
 * A search result whose heading is the page's *first* heading is often useless
 * ("Introduction"). When a query term appears under a heading, that heading is
 * the more useful answer, so headings are ranked by how many query terms they
 * contain.
 */
function bestHeading(record: ConceptRecord, terms: readonly string[]): string {
  if (record.headings.length === 0) return "";
  let best = record.headings[0] ?? "";
  let bestScore = -1;
  for (const heading of record.headings) {
    const lower = heading.toLowerCase();
    let score = 0;
    for (const term of terms) if (lower.includes(term)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = heading;
    }
  }
  return best;
}

/**
 * Rank the corpus for one query.
 *
 * Pure and synchronous: the index is already in memory, so this is the cheap
 * half of a search. The caller applies the configured `maxResults` before
 * calling; `limit` here is the effective one.
 */
export function searchConcepts(
  index: CorpusIndex,
  query: string,
  options: SearchOptions,
): SearchOutcome {
  const terms = tokenize(query);
  const allowed = new Set(options.allowedBundles);

  const candidates = index.concepts.filter((record) => {
    if (allowed.size > 0 && !allowed.has(record.bundle)) return false;
    if (options.bundle !== undefined && record.bundle !== options.bundle) return false;
    if (options.type !== undefined && record.type.toLowerCase() !== options.type.toLowerCase()) {
      return false;
    }
    return true;
  });

  if (terms.length === 0) {
    return { mode: "all", hits: [], considered: candidates.length, more: false };
  }

  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  const scored = candidates.map((record) => scoreRecord(record, terms, phrase));

  const complete = scored.filter((entry) => entry.missing.length === 0);
  const partial = scored.filter((entry) => entry.missing.length < terms.length);

  const mode: "all" | "any" = complete.length > 0 ? "all" : "any";
  const pool = complete.length > 0 ? complete : partial;

  const ordered = [...pool].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic ties: a stable order is what makes a test (and a transcript)
    // reproducible.
    const byTitle = a.record.title.localeCompare(b.record.title);
    if (byTitle !== 0) return byTitle;
    return a.record.conceptId.localeCompare(b.record.conceptId);
  });

  const hits: SearchHit[] = ordered.slice(0, options.limit).map((entry) => ({
    bundle: entry.record.bundle,
    conceptId: entry.record.conceptId,
    title: entry.record.title,
    type: entry.record.type,
    heading: bestHeading(entry.record, terms),
    snippet: buildSnippet(entry.record.bodyPreview, terms),
    resource: entry.record.resource,
    timestamp: entry.record.timestamp,
    score: Math.round(entry.score * 100) / 100,
  }));

  return {
    mode,
    hits,
    considered: candidates.length,
    more: ordered.length > hits.length,
  };
}
