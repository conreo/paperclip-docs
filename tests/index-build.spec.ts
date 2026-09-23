import { describe, expect, it } from "vitest";

import {
  BUILD_ACTIVE_WINDOW_MS,
  countJournalEntries,
  describeBuild,
  describeIndexLine,
} from "../src/index-build.js";

const NOW = Date.parse("2026-09-23T19:00:00Z");
const FRESH = NOW - 5_000;
const STALE = NOW - BUILD_ACTIVE_WINDOW_MS - 60_000;

describe("journal reading", () => {
  it("counts one entry per non-empty line", () => {
    expect(countJournalEntries("a/b.md\nc/d.md\n")).toBe(2);
    expect(countJournalEntries("a/b.md\n\n c/d.md \n")).toBe(2);
    expect(countJournalEntries("")).toBe(0);
    // A torn final line — the writer was killed mid-append — is not an entry for a
    // file that never got its newline.
    expect(countJournalEntries("a/b.md\nc/d.md")).toBe(2);
  });
});

describe("build progress", () => {
  it("says nothing when there is no journal", () => {
    expect(
      describeBuild({ done: 0, total: 100, updatedAtMs: null, hasIndex: false, nowMs: NOW }),
    ).toBeNull();
    expect(
      describeBuild({ done: 0, total: 100, updatedAtMs: FRESH, hasIndex: false, nowMs: NOW }),
    ).toBeNull();
  });

  it("reports an active build while the journal is being written", () => {
    const build = describeBuild({
      done: 5600,
      total: 13029,
      updatedAtMs: FRESH,
      hasIndex: false,
      nowMs: NOW,
    });
    expect(build).not.toBeNull();
    expect(build?.active).toBe(true);
    expect(build?.percent).toBe(43);
    expect(build?.interrupted).toBe(false);
    expect(build?.updatedAt).toBe(new Date(FRESH).toISOString());
  });

  it("calls a silent journal interrupted, not progress", () => {
    // The indexer was killed: the journal is there, the index is not, and nothing
    // has been written for longer than the active window.
    const build = describeBuild({
      done: 900,
      total: 13029,
      updatedAtMs: STALE,
      hasIndex: false,
      nowMs: NOW,
    });
    expect(build?.active).toBe(false);
    expect(build?.interrupted).toBe(true);
  });

  it("does not cry interrupted when an index already exists", () => {
    // A leftover journal beside a finished index is a rebuild that succeeded.
    const build = describeBuild({
      done: 900,
      total: 13029,
      updatedAtMs: STALE,
      hasIndex: true,
      nowMs: NOW,
    });
    expect(build?.interrupted).toBe(false);
    expect(build?.active).toBe(false);
  });

  it("clamps a count that overshoots the corpus", () => {
    const build = describeBuild({
      done: 14000,
      total: 13029,
      updatedAtMs: FRESH,
      hasIndex: false,
      nowMs: NOW,
    });
    expect(build?.percent).toBe(100);
  });

  it("still reports freshness when the total is unknown", () => {
    const build = describeBuild({
      done: 100,
      total: 0,
      updatedAtMs: FRESH,
      hasIndex: false,
      nowMs: NOW,
    });
    expect(build?.active).toBe(true);
    expect(build?.percent).toBe(0);
    expect(build?.interrupted).toBe(false);
  });
});

describe("the index line", () => {
  it("names the vectors, the width, the model and the age", () => {
    expect(
      describeIndexLine({
        count: 13029,
        dim: 1024,
        model: "bge-m3",
        complete: true,
        builtAt: "2026-09-23T18:40:14Z",
      }),
    ).toBe("13,029 vectors of 1024 dimensions, from bge-m3, built 2026-09-23T18:40:14Z.");
  });

  it("says so when the index covers only some bundles", () => {
    const line = describeIndexLine({
      count: 256,
      dim: 1024,
      model: "bge-m3",
      complete: false,
      builtAt: "",
    });
    expect(line).toContain("covering only some bundles");
    expect(line).not.toContain("built");
  });
});
