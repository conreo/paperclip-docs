/**
 * Optional semantic retrieval over the corpus.
 *
 * ## Why there is no vector database here
 *
 * The plugin worker cannot spawn a process, so it cannot host a native vector
 * store, and this plugin's whole trust story is that it reads an artifact and owns
 * nothing. So the index is two files the builder already wrote — a metadata
 * document and a flat float32 matrix — and the arithmetic happens here.
 *
 * Brute force is not a compromise at this size: a few thousand concepts of a few
 * hundred dimensions is a couple of million multiply-adds, which is single-digit
 * milliseconds in JavaScript. A vector database would be a dependency, a process and
 * a second thing to keep in sync, to save a number nobody can perceive.
 *
 * ## Keyword stays the baseline
 *
 * This module never *replaces* keyword search. It contributes candidates and a
 * score, which {@link blendWithKeyword} mixes with the keyword ranking. Retrieval
 * runs only when the operator enabled it, an index exists, and an endpoint is
 * configured — and every failure anywhere in that path degrades to keyword-only
 * results, because a documentation answer that arrives without a vector is worth
 * incomparably more than an error page.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EMBEDDINGS_BIN, EMBEDDINGS_JSON, EMBEDDINGS_SCHEMA } from "./constants.js";
import type { RuntimeRagConfig } from "./runtime-config.js";

export interface EmbeddingIndex {
  model: string;
  dim: number;
  count: number;
  /** Row order of the matrix: `conceptIds[row]` owns vector `row`. */
  conceptIds: string[];
  /** False when the index covers only some bundles — a carried-over build. */
  complete: boolean;
  bundles: string[];
  vectors: Float32Array;
}

/** One semantic candidate, in the shape search results use. */
export interface SemanticCandidate {
  conceptId: string;
  score: number;
}

/**
 * Load an index, cached against the file's mtime.
 *
 * Keyed by root and invalidated by the index's mtime, exactly like the corpus
 * index: a rebuild must be picked up without a restart, and a search must not
 * re-read a multi-megabyte matrix per query.
 */
const cache = new Map<string, { signature: string; index: Promise<EmbeddingIndex | null> }>();

async function signatureOf(root: string): Promise<string> {
  try {
    const stat = await fs.stat(path.join(root, EMBEDDINGS_JSON));
    const binary = await fs.stat(path.join(root, EMBEDDINGS_BIN));
    return `${stat.mtimeMs}:${stat.size}:${binary.mtimeMs}:${binary.size}`;
  } catch {
    return "";
  }
}

export async function loadIndex(root: string): Promise<EmbeddingIndex | null> {
  const signature = await signatureOf(root);
  if (signature === "") return null;
  const cached = cache.get(root);
  if (cached && cached.signature === signature) return cached.index;
  const promise = readIndex(root).catch(() => null);
  cache.set(root, { signature, index: promise });
  return promise;
}

/** Drop the cache. Exported for tests and for a rebuild triggered from the UI. */
export function invalidateIndex(root?: string): void {
  if (root === undefined) cache.clear();
  else cache.delete(root);
}

async function readIndex(root: string): Promise<EmbeddingIndex | null> {
  const meta = JSON.parse(await fs.readFile(path.join(root, EMBEDDINGS_JSON), "utf8")) as unknown;
  if (typeof meta !== "object" || meta === null) return null;
  const record = meta as Record<string, unknown>;

  // A schema this plugin does not know is not read "best effort": the row order of
  // the matrix would be a guess, and every result after the first would be wrong.
  if (record["schema"] !== EMBEDDINGS_SCHEMA) return null;

  const dim = record["dim"];
  const count = record["count"];
  const conceptIds = record["concept_ids"];
  if (typeof dim !== "number" || typeof count !== "number" || !Array.isArray(conceptIds)) return null;
  if (dim <= 0 || count <= 0 || conceptIds.length !== count) return null;
  if (!conceptIds.every((id): id is string => typeof id === "string")) return null;

  const raw = await fs.readFile(path.join(root, EMBEDDINGS_BIN));
  const expected = count * dim * 4;
  if (raw.byteLength !== expected) return null;
  if (os.endianness() !== "LE") return null; // the builder writes little-endian

  const vectors = new Float32Array(count * dim);
  for (let index = 0; index < vectors.length; index += 1) {
    vectors[index] = raw.readFloatLE(index * 4);
  }

  return {
    model: typeof record["model"] === "string" ? record["model"] : "",
    dim,
    count,
    conceptIds,
    complete: record["complete"] !== false,
    bundles: Array.isArray(record["bundles"])
      ? record["bundles"].filter((b): b is string => typeof b === "string")
      : [],
    vectors,
  };
}

/** Cosine similarity. Returns 0 for a zero vector rather than NaN. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>, offset = 0, dim = a.length): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < dim; index += 1) {
    const left = a[index] ?? 0;
    const right = b[offset + index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * The best `topK` concepts by similarity, highest first.
 *
 * Ties break on concept id so the order is stable: an unstable ranking makes a
 * search result flaky in a way that is very hard to report.
 */
export function semanticRank(
  index: EmbeddingIndex,
  query: number[],
  topK: number,
  allowedBundles: string[] = [],
): SemanticCandidate[] {
  if (query.length !== index.dim) return [];
  const scored: SemanticCandidate[] = [];
  for (let row = 0; row < index.count; row += 1) {
    const conceptId = index.conceptIds[row];
    if (conceptId === undefined) continue;
    if (allowedBundles.length > 0) {
      const bundle = conceptId.split("/")[0] ?? "";
      if (!allowedBundles.includes(bundle)) continue;
    }
    scored.push({ conceptId, score: cosine(query, index.vectors, row * index.dim, index.dim) });
  }
  scored.sort((left, right) =>
    right.score === left.score
      ? left.conceptId.localeCompare(right.conceptId)
      : right.score - left.score,
  );
  return scored.slice(0, Math.max(0, topK));
}

/**
 * Mix semantic candidates into a keyword ranking.
 *
 * Both sides are normalised by their own best score before mixing, because they are
 * not in the same units: keyword scores are field weights summed, similarity is a
 * cosine. A concept found only semantically keeps its blended share, which is the
 * entire point — a page that says "single sign-on" and never the letters "SSO" has
 * no keyword score to be beaten by.
 */
export function blendWithKeyword(
  keywordScores: Map<string, number>,
  semantic: SemanticCandidate[],
  weight: number,
): Map<string, number> {
  const mixed = new Map<string, number>();
  const keywordBest = Math.max(0, ...keywordScores.values());
  const semanticBest = Math.max(0, ...semantic.map((candidate) => candidate.score));
  const clamped = Math.min(1, Math.max(0, weight));

  for (const [conceptId, score] of keywordScores) {
    const normalised = keywordBest > 0 ? score / keywordBest : 0;
    mixed.set(conceptId, (1 - clamped) * normalised);
  }
  for (const { conceptId, score } of semantic) {
    if (score <= 0) continue; // a negative cosine is not evidence of relevance
    const normalised = semanticBest > 0 ? score / semanticBest : 0;
    mixed.set(conceptId, (mixed.get(conceptId) ?? 0) + clamped * normalised);
  }
  return mixed;
}

/** The narrow slice of the host's HTTP client this module needs. */
export interface HttpFetch {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

/**
 * Embed one string with an OpenAI-compatible endpoint.
 *
 * Throws on anything unexpected; the caller decides whether that is worth telling
 * the operator about, and it always is — a RAG that is silently off is a RAG the
 * operator believes is on.
 */
export async function embedQuery(
  http: HttpFetch,
  config: RuntimeRagConfig,
  query: string,
  apiKey: string,
): Promise<number[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const response = await http(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: config.model, input: [query] }),
  });
  if (!response.ok) {
    throw new Error(`the embedding endpoint answered ${response.status}`);
  }
  const body = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
  const vector = body?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || !vector.every((value) => typeof value === "number")) {
    throw new Error("the embedding endpoint returned no usable vector");
  }
  return vector as number[];
}
