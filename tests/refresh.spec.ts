/**
 * Refresh requests.
 *
 * The plugin cannot build: the runtime offers no way to spawn a process, so `git`
 * and `pandoc` are out of reach and a rebuild is something this worker is not able
 * to do. What it can do is write a request. These tests pin the two things that
 * matter about that: *when* it asks, and that it never asks silently or crashes
 * when it cannot.
 */

import { describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildRefreshRequest,
  corpusAgeDays,
  readRefreshResponse,
  requestsDirFor,
  shouldRequestRefresh,
  writeRefreshRequest,
} from "../src/refresh.js";
import { REFRESH_REQUEST_SCHEMA, REQUEST_FILENAME, RESPONSE_FILENAME } from "../src/constants.js";
import type { RuntimeSourceDeclaration } from "../src/runtime-config.js";

const SOURCE: RuntimeSourceDeclaration = {
  id: "n8n",
  title: "n8n",
  kind: "git",
  repo: "https://github.com/n8n-io/n8n-docs",
  url: "",
  ref: "main",
  path: "docs",
  convert: "auto",
  include: ["**/*.md"],
  exclude: [],
  tags: ["n8n"],
};

const NOW = new Date("2026-09-23T12:00:00Z");

function tempCorpus(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-refresh-"));
  return path.join(root, "okf-bundles");
}

describe("corpus age", () => {
  it("reads the build manifest, not file timestamps", () => {
    // A `cp -r` or a restore makes every file look new, so mtime would report a
    // corpus as fresh forever and a rebuild would never be requested.
    expect(corpusAgeDays({ built_at: "2026-09-13T12:00:00Z" }, NOW)).toBe(10);
  });

  it("reports null rather than guessing when there is nothing to read", () => {
    expect(corpusAgeDays(null, NOW)).toBeNull();
    expect(corpusAgeDays({}, NOW)).toBeNull();
    expect(corpusAgeDays({ built_at: "not a date" }, NOW)).toBeNull();
    expect(corpusAgeDays({ built_at: 17 }, NOW)).toBeNull();
  });
});

describe("when to ask for a rebuild", () => {
  const base = {
    refreshEnabled: true,
    maxAgeDays: 30,
    ageDays: 10,
    sources: [SOURCE],
  };

  it("stays quiet when the corpus is fresh", () => {
    const decision = shouldRequestRefresh(base);
    expect(decision.request).toBe(false);
    expect(decision.reason).toContain("10 days old");
  });

  it("asks when the corpus is past the limit", () => {
    expect(shouldRequestRefresh({ ...base, ageDays: 30 }).request).toBe(true);
    expect(shouldRequestRefresh({ ...base, ageDays: 400 }).request).toBe(true);
  });

  it("asks when the age is unknown, because unknown is not fresh", () => {
    // A missing manifest is the state a build failure leaves behind. Treating it
    // as fresh would mean a corpus that silently never rebuilds.
    expect(shouldRequestRefresh({ ...base, ageDays: null }).request).toBe(true);
    expect(
      shouldRequestRefresh({ ...base, ageDays: 1, manifestError: "manifest is not a JSON object" })
        .request,
    ).toBe(true);
  });

  it("distinguishes 'refresh is off' from 'already fresh'", () => {
    // An operator chasing a rebuild that never happens needs to tell these apart.
    expect(shouldRequestRefresh({ ...base, refreshEnabled: false }).reason).toContain("off");
    expect(shouldRequestRefresh({ ...base, sources: [] }).reason).toContain("no sources");
  });
});

describe("the request payload", () => {
  it("is versioned, so a runner can refuse a shape it does not know", () => {
    const request = buildRefreshRequest("/corpus", [SOURCE], "test", { now: NOW });
    expect(request.schema).toBe(REFRESH_REQUEST_SCHEMA);
    expect(request.requestedAt).toBe(NOW.toISOString());
    expect(request.corpusRoot).toBe("/corpus");
    expect(request.sources).toEqual([SOURCE]);
  });

  it("copies its sources instead of aliasing the config", () => {
    // The payload is serialized and handed to another process; a later config
    // mutation must not change a request already written.
    const sources = [SOURCE];
    const request = buildRefreshRequest("/corpus", sources, "test", { now: NOW });
    sources[0]!.id = "mutated";
    expect(request.sources[0]!.id).toBe("n8n");
  });

  it("bounds the reason it carries", () => {
    const request = buildRefreshRequest("/corpus", [], "x".repeat(5_000), { now: NOW });
    expect(request.reason.length).toBe(500);
  });
});

describe("writing the request", () => {
  it("goes to a sibling of the corpus, derived from it, with nothing configured", async () => {
    // The first version made the operator choose a folder for this, which is a
    // deployment detail leaking into a settings page — and it showed the plugin as
    // "needs attention" until they picked one.
    const corpus = tempCorpus();
    const outcome = await writeRefreshRequest(corpus, buildRefreshRequest(corpus, [SOURCE], "why", { now: NOW }));
    expect(outcome).toEqual({ written: true, path: path.join(`${corpus}.requests`, REQUEST_FILENAME) });
    expect(requestsDirFor(corpus)).toBe(`${corpus}.requests`);
    // A sibling, never inside: the corpus is replaced by a rename on every rebuild,
    // so anything written inside it would be discarded. Note the separator — a
    // string-prefix test would pass on `okf-bundles.requests` while telling us
    // nothing about containment.
    expect(path.dirname(requestsDirFor(corpus))).toBe(path.dirname(corpus));
    expect(requestsDirFor(corpus).startsWith(corpus + path.sep)).toBe(false);
    fs.rmSync(path.dirname(corpus), { recursive: true, force: true });
  });

  it("creates the directory and leaves no temporary file behind", async () => {
    const corpus = tempCorpus();
    await writeRefreshRequest(corpus, buildRefreshRequest(corpus, [SOURCE], "why", { now: NOW }));
    const dir = requestsDirFor(corpus);
    expect(fs.readdirSync(dir)).toEqual([REQUEST_FILENAME]);
    // Written to a temp name and renamed, so a runner polling the directory cannot
    // read half a document.
    const written = JSON.parse(fs.readFileSync(path.join(dir, REQUEST_FILENAME), "utf8"));
    expect(written.schema).toBe(REFRESH_REQUEST_SCHEMA);
    expect(written.sources).toHaveLength(1);
    fs.rmSync(path.dirname(corpus), { recursive: true, force: true });
  });

  it("reports a failed write rather than throwing", async () => {
    // A file where the parent directory should be: deterministic on any platform.
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "docs-blocked-")), "file");
    fs.writeFileSync(blocker, "not a directory");
    const corpus = path.join(blocker, "okf-bundles");
    const outcome = await writeRefreshRequest(corpus, buildRefreshRequest(corpus, [], "r", { now: NOW }));
    expect(outcome.written).toBe(false);
    expect(outcome.written === false && outcome.skipped).toContain("could not be written");
    fs.rmSync(path.dirname(blocker), { recursive: true, force: true });
  });

  it("reads the runner's reply, and copes with there not being one", async () => {
    const corpus = tempCorpus();
    expect(await readRefreshResponse(corpus)).toBeNull();

    await writeRefreshRequest(corpus, buildRefreshRequest(corpus, [], "why", { now: NOW }));
    fs.writeFileSync(
      path.join(requestsDirFor(corpus), RESPONSE_FILENAME),
      JSON.stringify({ status: "built", pages: 4320 }),
    );
    expect((await readRefreshResponse(corpus))?.status).toBe("built");

    // Corrupt or half-written: reported as absent, never as a crash in a page.
    fs.writeFileSync(path.join(requestsDirFor(corpus), RESPONSE_FILENAME), "{not json");
    expect(await readRefreshResponse(corpus)).toBeNull();
    fs.rmSync(path.dirname(corpus), { recursive: true, force: true });
  });
});
describe("what a request asks the runner for", () => {
  it("asks for the corpus alone by default, and carries no embed block", () => {
    const request = buildRefreshRequest("/corpus", [SOURCE], "test", { now: NOW });
    expect(request.mode).toBe("okf");
    expect(request.embed).toBeUndefined();
  });

  it("asks for both when an embedding endpoint is configured", () => {
    // A corpus rebuild replaces the directory the index lives in, so the request that
    // refreshes the corpus is also the one that has to rebuild the index.
    const request = buildRefreshRequest("/corpus", [SOURCE], "test", {
      now: NOW,
      embed: { endpoint: "http://127.0.0.1:11434/v1/embeddings", model: "nomic-embed-text" },
    });
    expect(request.mode).toBe("both");
    expect(request.embed).toEqual({
      endpoint: "http://127.0.0.1:11434/v1/embeddings",
      model: "nomic-embed-text",
    });
  });

  it("rebuilds an index with no sources at all, because none are needed", () => {
    const request = buildRefreshRequest("/corpus", [], "test", {
      now: NOW,
      mode: "index",
      embed: { endpoint: "http://127.0.0.1:11434/v1/embeddings", model: "m" },
    });
    expect(request.mode).toBe("index");
    expect(request.sources).toEqual([]);
    expect(request.embed?.model).toBe("m");
  });

  it("never attaches an embed block to a corpus-only request", () => {
    // The runner refuses `okf` with an embed block, and a request the runner refuses
    // is worse than one that asks for less.
    const request = buildRefreshRequest("/corpus", [SOURCE], "test", {
      now: NOW,
      mode: "okf",
      embed: { endpoint: "http://127.0.0.1:11434/v1/embeddings", model: "m" },
    });
    expect(request.embed).toBeUndefined();
  });

  it("carries a removal only on a prune request", () => {
    // A deletion attached to a build request is the one combination that could delete
    // something nobody asked to delete.
    const prune = buildRefreshRequest("/corpus", [], "test", {
      now: NOW,
      mode: "prune",
      remove: { bundles: ["nextcloud"] },
    });
    expect(prune.mode).toBe("prune");
    expect(prune.remove).toEqual({ bundles: ["nextcloud"] });
    expect(prune.embed).toBeUndefined();

    const build = buildRefreshRequest("/corpus", [SOURCE], "test", {
      now: NOW,
      mode: "both",
      remove: { bundles: ["nextcloud"] },
    });
    expect(build.remove).toBeUndefined();
  });

  it("drops an empty removal rather than writing a request the runner refuses", () => {
    const request = buildRefreshRequest("/corpus", [], "test", {
      now: NOW,
      mode: "prune",
      remove: { bundles: [] },
    });
    expect(request.remove).toBeUndefined();
  });
});
