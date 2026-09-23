import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PathRefusal, isContainedIn, resolveWithinRoot } from "../src/corpus/safe-path.js";
import { readConcept } from "../src/corpus/store.js";
import { createFixtureCorpus, type FixtureCorpus } from "./fixtures/corpus.js";

/**
 * These are the tests that matter most in this plugin.
 *
 * `read_doc` and `list_docs` accept a path from an agent. Without the checks in
 * `safe-path.ts`, `../../etc/passwd` is a filesystem read primitive dressed up as
 * a documentation lookup. Each rule therefore has a direct assertion here, plus
 * a positive case so the rule cannot be "fixed" by refusing everything.
 */

let fixture: FixtureCorpus | null = null;

afterEach(async () => {
  if (fixture) await fixture.cleanup();
  fixture = null;
});

describe("resolveWithinRoot — accepted paths", () => {
  it("resolves a normal nested path against the root", async () => {
    fixture = await createFixtureCorpus({ "a/b/c.md": "x" });
    expect(resolveWithinRoot(fixture.root, "a/b/c.md")).toBe(
      path.join(fixture.root, "a", "b", "c.md"),
    );
  });

  it("does not mistake a filename containing dots for traversal", async () => {
    fixture = await createFixtureCorpus({ "v1..2.md": "x" });
    expect(resolveWithinRoot(fixture.root, "v1..2.md")).toBe(
      path.join(fixture.root, "v1..2.md"),
    );
  });

  it("normalises `./` and repeated separators", async () => {
    fixture = await createFixtureCorpus({ "a/b.md": "x" });
    expect(resolveWithinRoot(fixture.root, "./a//b.md")).toBe(
      path.join(fixture.root, "a", "b.md"),
    );
  });

  it("allows a symlink that points inside the root", async () => {
    fixture = await createFixtureCorpus({ "real/page.md": "x" });
    fs.symlinkSync(path.join(fixture.root, "real"), path.join(fixture.root, "alias"));
    expect(resolveWithinRoot(fixture.root, "alias/page.md")).toBe(
      path.join(fixture.root, "alias", "page.md"),
    );
  });
});

describe("resolveWithinRoot — refused paths", () => {
  it("refuses `../etc/passwd`", async () => {
    fixture = await createFixtureCorpus({ "a.md": "x" });
    expect(() => resolveWithinRoot(fixture!.root, "../etc/passwd")).toThrow(PathRefusal);
    try {
      resolveWithinRoot(fixture.root, "../etc/passwd");
    } catch (error) {
      expect((error as PathRefusal).code).toBe("path_traversal");
    }
  });

  it("refuses traversal hidden in the middle of an otherwise valid path", async () => {
    fixture = await createFixtureCorpus({ "sub/page.md": "x" });
    try {
      resolveWithinRoot(fixture.root, "sub/../../etc/passwd");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as PathRefusal).code).toBe("path_traversal");
    }
  });

  it("refuses an absolute path", async () => {
    fixture = await createFixtureCorpus({ "a.md": "x" });
    try {
      resolveWithinRoot(fixture.root, "/etc/passwd");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as PathRefusal).code).toBe("absolute_path");
    }
  });

  it("refuses a Windows absolute path", async () => {
    fixture = await createFixtureCorpus({ "a.md": "x" });
    expect(() => resolveWithinRoot(fixture!.root, "C:\\Windows\\system32\\config")).toThrow(
      PathRefusal,
    );
  });

  it("refuses a UNC-style path", async () => {
    fixture = await createFixtureCorpus({ "a.md": "x" });
    expect(() => resolveWithinRoot(fixture!.root, "\\\\server\\share\\file")).toThrow(PathRefusal);
  });

  it("refuses a non-string and an empty path", async () => {
    fixture = await createFixtureCorpus({ "a.md": "x" });
    expect(() => resolveWithinRoot(fixture!.root, null)).toThrow(PathRefusal);
    expect(() => resolveWithinRoot(fixture!.root, 42)).toThrow(PathRefusal);
    expect(() => resolveWithinRoot(fixture!.root, "   ")).toThrow(PathRefusal);
  });

  it("refuses a symlink that escapes the root, even when nested", async () => {
    fixture = await createFixtureCorpus({ "inside.md": "x" });
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "paperclip-docs-outside-"));
    try {
      await fs.promises.writeFile(path.join(outside, "secret.md"), "top secret", "utf8");
      fs.symlinkSync(outside, path.join(fixture.root, "link"));

      try {
        resolveWithinRoot(fixture.root, "link/secret.md");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as PathRefusal).code).toBe("symlink_escape");
      }
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("readConcept — refusals never become reads", () => {
  it("refuses `../etc/passwd` with a named code rather than throwing", async () => {
    fixture = await createFixtureCorpus({ "a.md": "x" });
    const outcome = await readConcept(fixture.root, "../etc/passwd", { maxChars: 1_000 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("refused");
  });

  it("refuses an absolute path", async () => {
    fixture = await createFixtureCorpus({ "a.md": "x" });
    const outcome = await readConcept(fixture.root, "/etc/passwd", { maxChars: 1_000 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("refused");
  });

  it("returns a clean not-found for a missing concept instead of throwing", async () => {
    fixture = await createFixtureCorpus({ "a.md": "x" });
    const outcome = await readConcept(fixture.root, "does/not/exist.md", { maxChars: 1_000 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("not_found");
      expect(outcome.message).toMatch(/no concept exists/i);
    }
  });
});

describe("isContainedIn", () => {
  it("accepts the root itself and children", () => {
    expect(isContainedIn("/srv/corpus", "/srv/corpus")).toBe(true);
    expect(isContainedIn("/srv/corpus", "/srv/corpus/a/b.md")).toBe(true);
  });

  it("rejects siblings and parents", () => {
    expect(isContainedIn("/srv/corpus", "/srv/other")).toBe(false);
    expect(isContainedIn("/srv/corpus", "/srv")).toBe(false);
    expect(isContainedIn("/srv/corpus", "/srv/corpus-evil/x")).toBe(false);
  });
});
