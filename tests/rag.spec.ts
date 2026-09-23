/**
 * Semantic retrieval.
 *
 * Keyword search is the baseline and stays that way; this is the optional extra.
 * The tests that matter are therefore about *failure*: an index built by a different
 * model, a missing index, an endpoint that is down, a partial index. Every one of
 * them must produce keyword results and a sentence saying so — never an error page,
 * and never a silent pretense that semantic search ran.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EMBEDDINGS_BIN, EMBEDDINGS_JSON } from "../src/constants.js";
import {
  blendWithKeyword,
  cosine,
  describeIndex,
  embedQuery,
  invalidateIndex,
  loadIndex,
  semanticRank,
  type EmbeddingIndex,
  type HttpFetch,
} from "../src/rag.js";
import { semanticProviderFor } from "../src/worker.js";
import { normalizeConfig } from "../src/runtime-config.js";

const roots: string[] = [];
afterEach(() => {
  invalidateIndex();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Write a real index on disk, the way the builder does. */
function writeIndex(
  rows: Array<{ id: string; vector: number[] }>,
  overrides: Record<string, unknown> = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-rag-"));
  roots.push(root);
  const flat = rows.flatMap((row) => row.vector);
  const buffer = Buffer.alloc(flat.length * 4);
  flat.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  fs.writeFileSync(path.join(root, EMBEDDINGS_BIN), buffer);
  fs.writeFileSync(
    path.join(root, EMBEDDINGS_JSON),
    JSON.stringify({
      schema: 1,
      model: "test-model",
      dim: rows[0]?.vector.length ?? 0,
      count: rows.length,
      concept_ids: rows.map((row) => row.id),
      complete: true,
      bundles: [...new Set(rows.map((row) => row.id.split("/")[0]))],
      built_at: "2026-09-23T00:00:00Z",
      ...overrides,
    }),
  );
  return root;
}

describe("loading the index", () => {
  it("reads the matrix in row order", async () => {
    const root = writeIndex([
      { id: "a/one.md", vector: [1, 0, 0] },
      { id: "b/two.md", vector: [0, 1, 0] },
    ]);
    const index = await loadIndex(root);
    expect(index?.dim).toBe(3);
    expect(index?.count).toBe(2);
    expect(index?.conceptIds).toEqual(["a/one.md", "b/two.md"]);
    expect(Array.from(index!.vectors.slice(3, 6))).toEqual([0, 1, 0]);
  });

  it("returns null rather than guessing when there is no index", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "docs-none-"));
    roots.push(empty);
    expect(await loadIndex(empty)).toBeNull();
  });

  it("refuses an index from a schema it does not know", async () => {
    // Reading it best-effort would make the row order a guess, and every result
    // after the first would be wrong in a way nothing could detect.
    const root = writeIndex([{ id: "a/one.md", vector: [1, 0] }], { schema: 99 });
    expect(await loadIndex(root)).toBeNull();
  });

  it("refuses a matrix whose size disagrees with its metadata", async () => {
    const root = writeIndex([{ id: "a/one.md", vector: [1, 0, 0] }], { count: 5 });
    expect(await loadIndex(root)).toBeNull();
  });

  it("caches on the file's mtime, so a rebuild is picked up without a restart", async () => {
    const root = writeIndex([{ id: "a/one.md", vector: [1, 0] }]);
    const first = await loadIndex(root);
    expect(await loadIndex(root)).toBe(first);

    writeIndex([{ id: "a/one.md", vector: [0.5, 0.5] }]);
    fs.rmSync(root, { recursive: true, force: true });
    const rebuilt = writeIndex([{ id: "a/one.md", vector: [0, 1] }]);
    expect((await loadIndex(rebuilt))?.conceptIds).toEqual(["a/one.md"]);
  });
});

describe("ranking", () => {
  const index: EmbeddingIndex = {
    model: "test-model",
    dim: 2,
    count: 3,
    conceptIds: ["a/close.md", "a/far.md", "b/other.md"],
    complete: true,
    bundles: ["a", "b"],
    vectors: Float32Array.from([1, 0, 0, 1, 0.9, 0.1]),
  };

  it("orders by similarity", () => {
    const ranked = semanticRank(index, [1, 0], 3);
    expect(ranked.map((candidate) => candidate.conceptId)).toEqual([
      "a/close.md",
      "b/other.md",
      "a/far.md",
    ]);
  });

  it("obeys the bundle allowlist, so retrieval is not a way around one", () => {
    const ranked = semanticRank(index, [1, 0], 3, ["a"]);
    expect(ranked.map((candidate) => candidate.conceptId)).toEqual(["a/close.md", "a/far.md"]);
  });

  it("caps the candidates it returns", () => {
    expect(semanticRank(index, [1, 0], 1)).toHaveLength(1);
  });

  it("returns nothing when the query vector does not match the index", () => {
    // A query embedded by a different model has a different width. Returning
    // partial results here would rank on the first two dimensions of an unrelated
    // vector.
    expect(semanticRank(index, [1, 0, 0], 3)).toEqual([]);
  });

  it("cosine is 0 for a zero vector rather than NaN", () => {
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
});

describe("blending with the keyword ranking", () => {
  it("keeps a semantic-only find, and lets it outrank a weak keyword match", () => {
    // A page that says "single sign-on" and never "SSO" has no keyword score at
    // all. The point of the blend is that it is *retained* and beats a document
    // that merely mentions a term in passing — not that it beats a document which
    // matches the keywords and is also similar, which should win.
    const blended = blendWithKeyword(
      new Map([
        ["a/exact.md", 32],
        ["a/weak.md", 1],
      ]),
      [
        { conceptId: "a/exact.md", score: 0.9 },
        { conceptId: "b/paraphrase.md", score: 0.95 },
      ],
      0.5,
    );
    // Retained, with a non-zero share.
    expect(blended.get("b/paraphrase.md")!).toBeGreaterThan(0);
    // Beaten by the document that matches on both signals...
    expect(blended.get("a/exact.md")!).toBeGreaterThan(blended.get("b/paraphrase.md")!);
    // ...and ahead of one that only mentions a term in passing.
    expect(blended.get("b/paraphrase.md")!).toBeGreaterThan(blended.get("a/weak.md")!);
  });

  it("weight 0 leaves the keyword ranking alone", () => {
    const blended = blendWithKeyword(
      new Map([["a/one.md", 10]]),
      [{ conceptId: "b/two.md", score: 1 }],
      0,
    );
    expect(blended.get("a/one.md")).toBe(1);
    expect(blended.get("b/two.md")).toBe(0);
  });

  it("weight 1 ignores keyword entirely", () => {
    const blended = blendWithKeyword(
      new Map([["a/one.md", 10]]),
      [{ conceptId: "b/two.md", score: 1 }],
      1,
    );
    expect(blended.get("a/one.md")).toBe(0);
    expect(blended.get("b/two.md")).toBe(1);
  });

  it("ignores negative similarity, which is evidence of nothing", () => {
    const blended = blendWithKeyword(new Map(), [{ conceptId: "a/opposite.md", score: -0.8 }], 1);
    expect(blended.size).toBe(0);
  });
});

describe("the embedding request", () => {
  const config = { enabled: true, endpoint: "https://embed.example/v1", model: "m", secretRef: "", topK: 5, weight: 0.5 };

  it("speaks the OpenAI shape and sends the key as a bearer token", async () => {
    const seen: Array<{ url: string; body: unknown; auth?: string }> = [];
    const http: HttpFetch = async (url, init) => {
      seen.push({
        url,
        body: JSON.parse(String(init?.body)),
        auth: init?.headers?.["Authorization"],
      });
      return { ok: true, status: 200, async json() { return { data: [{ embedding: [1, 2, 3] }] }; } };
    };
    const vector = await embedQuery(http, config, "how do I rotate a key", "secret");
    expect(vector).toEqual([1, 2, 3]);
    expect(seen[0]?.url).toBe(config.endpoint);
    expect(seen[0]?.body).toEqual({ model: "m", input: ["how do I rotate a key"] });
    expect(seen[0]?.auth).toBe("Bearer secret");
  });

  it("throws on a bad status, so the caller can say why", async () => {
    const http: HttpFetch = async () => ({ ok: false, status: 503, async json() { return {}; } });
    await expect(embedQuery(http, config, "q", "")).rejects.toThrow("503");
  });

  it("throws on a response with no usable vector", async () => {
    const http: HttpFetch = async () => ({ ok: true, status: 200, async json() { return { data: [] }; } });
    await expect(embedQuery(http, config, "q", "")).rejects.toThrow("usable vector");
  });
});

describe("the provider degrades rather than failing", () => {
  function ctxWith(httpFetch: unknown, secret = "key") {
    return {
      http: { fetch: httpFetch },
      secrets: { resolve: async () => secret },
    } as never;
  }

  it("is absent when the operator has not enabled it", () => {
    const config = normalizeConfig({ enabled: true });
    expect(semanticProviderFor(ctxWith(async () => ({})), config, "/nowhere")).toBeUndefined();
  });

  it("reports a missing index instead of pretending", async () => {
    const config = normalizeConfig({
      enabled: true,
      rag: { enabled: true, endpoint: "https://e/v1", model: "m" },
    });
    const provider = semanticProviderFor(ctxWith(async () => ({})), config, "/definitely/absent");
    const { candidates, note } = await provider!.rank("anything");
    expect(candidates).toEqual([]);
    expect(note).toContain("no vector index");
  });

  it("reports a model mismatch, which would otherwise be silently meaningless", async () => {
    // Vectors from two different models are not comparable. Ranking with them would
    // produce confident nonsense, so it is refused and explained.
    const root = writeIndex([{ id: "a/one.md", vector: [1, 0] }], { model: "other-model" });
    const config = normalizeConfig({
      enabled: true,
      corpusRoot: root,
      rag: { enabled: true, endpoint: "https://e/v1", model: "configured-model" },
    });
    const provider = semanticProviderFor(ctxWith(async () => ({})), config, root);
    const { candidates, note } = await provider!.rank("q");
    expect(candidates).toEqual([]);
    expect(note).toContain("other-model");
    expect(note).toContain("configured-model");
  });

  it("falls back to keyword when the endpoint is down", async () => {
    const root = writeIndex([{ id: "a/one.md", vector: [1, 0] }]);
    const config = normalizeConfig({
      enabled: true,
      corpusRoot: root,
      rag: { enabled: true, endpoint: "https://e/v1", model: "test-model" },
    });
    const provider = semanticProviderFor(
      ctxWith(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
      config,
      root,
    );
    const { candidates, note } = await provider!.rank("q");
    expect(candidates).toEqual([]);
    expect(note).toContain("unavailable");
    expect(note).toContain("ECONNREFUSED");
  });

  it("ranks for real when everything is in place", async () => {
    const root = writeIndex([
      { id: "a/close.md", vector: [1, 0] },
      { id: "a/far.md", vector: [0, 1] },
    ]);
    const config = normalizeConfig({
      enabled: true,
      corpusRoot: root,
      rag: { enabled: true, endpoint: "https://e/v1", model: "test-model" },
    });
    const provider = semanticProviderFor(
      ctxWith(async () => ({
        ok: true,
        status: 200,
        async json() {
          return { data: [{ embedding: [1, 0] }] };
        },
      })),
      config,
      root,
    );
    const { candidates, note } = await provider!.rank("q");
    expect(candidates[0]?.conceptId).toBe("a/close.md");
    expect(note).toContain("semantic retrieval used");
  });
});

describe("describing the index to the settings page", () => {
  it("reports the model, size and completeness without loading the matrix", async () => {
    // The page has to say whether semantic retrieval can work at all. Loading a
    // multi-megabyte matrix to answer that would be absurd, so this reads the small
    // JSON and nothing else.
    const root = writeIndex(
      [
        { id: "a/one.md", vector: [1, 0, 0] },
        { id: "a/two.md", vector: [0, 1, 0] },
      ],
      { model: "bge-small", complete: false },
    );
    const summary = await describeIndex(root);
    expect(summary).toMatchObject({ model: "bge-small", count: 2, dim: 3, complete: false });
    expect(summary?.bundles).toEqual(["a"]);
  });

  it("is null when there is no index, which is the honest answer", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "docs-noindex-"));
    roots.push(empty);
    expect(await describeIndex(empty)).toBeNull();
  });

  it("is null for an index from a schema it does not know", async () => {
    const root = writeIndex([{ id: "a/one.md", vector: [1, 0] }], { schema: 99 });
    expect(await describeIndex(root)).toBeNull();
  });
});
