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

import {
  buildRefreshRequest,
  corpusAgeDays,
  shouldRequestRefresh,
  writeRefreshRequest,
  type RequestWriter,
} from "../src/refresh.js";
import { REFRESH_REQUEST_SCHEMA, REQUEST_FILENAME, REQUESTS_FOLDER_KEY } from "../src/constants.js";
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

function writer(record: unknown[]): RequestWriter {
  return {
    async writeTextAtomic(companyId, folderKey, relativePath, contents) {
      record.push({ companyId, folderKey, relativePath, contents });
      return { ready: true };
    },
  };
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
    const request = buildRefreshRequest("/corpus", [SOURCE], "test", NOW);
    expect(request.schema).toBe(REFRESH_REQUEST_SCHEMA);
    expect(request.requestedAt).toBe(NOW.toISOString());
    expect(request.corpusRoot).toBe("/corpus");
    expect(request.sources).toEqual([SOURCE]);
  });

  it("copies its sources instead of aliasing the config", () => {
    // The payload is serialized and handed to another process; a later config
    // mutation must not change a request already written.
    const sources = [SOURCE];
    const request = buildRefreshRequest("/corpus", sources, "test", NOW);
    sources[0]!.id = "mutated";
    expect(request.sources[0]!.id).toBe("n8n");
  });

  it("bounds the reason it carries", () => {
    const request = buildRefreshRequest("/corpus", [], "x".repeat(5_000), NOW);
    expect(request.reason.length).toBe(500);
  });
});

describe("writing the request", () => {
  it("writes into the declared folder, one file, atomically", async () => {
    const calls: unknown[] = [];
    const outcome = await writeRefreshRequest(
      writer(calls),
      "company-1",
      buildRefreshRequest("/corpus", [SOURCE], "because", NOW),
    );
    expect(outcome).toEqual({ written: true, path: `${REQUESTS_FOLDER_KEY}/${REQUEST_FILENAME}` });
    const call = calls[0] as { companyId: string; folderKey: string; relativePath: string; contents: string };
    expect(call.companyId).toBe("company-1");
    expect(call.folderKey).toBe(REQUESTS_FOLDER_KEY);
    expect(call.relativePath).toBe(REQUEST_FILENAME);
    expect(JSON.parse(call.contents).sources).toHaveLength(1);
  });

  it("explains itself when the host offers no local folders", async () => {
    // Not a crash: the settings page must be able to say why pressing the button
    // did nothing, and name the folder that has to be declared.
    const outcome = await writeRefreshRequest(undefined, "company-1", buildRefreshRequest("/c", [], "r", NOW));
    expect(outcome.written).toBe(false);
    expect(outcome.written === false && outcome.skipped).toContain(REQUESTS_FOLDER_KEY);
  });

  it("reports a failed write rather than throwing", async () => {
    const failing: RequestWriter = {
      async writeTextAtomic() {
        throw new Error("folder is not configured for this company");
      },
    };
    const outcome = await writeRefreshRequest(
      failing,
      "company-1",
      buildRefreshRequest("/c", [], "r", NOW),
    );
    expect(outcome.written).toBe(false);
    expect(outcome.written === false && outcome.skipped).toContain("not configured");
  });
});
