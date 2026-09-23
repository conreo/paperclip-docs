/**
 * Progressive disclosure for `list_docs`.
 *
 * The corpus is 10,500 files. An agent cannot read a directory listing of that
 * size, and would not want to: what it needs is the *shape* of the tree, one
 * level at a time. OKF supports exactly that with an `index.md` in every
 * directory, and this module follows the rule the format intends:
 *
 *   - if the requested directory has an `index.md`, return it — the builder
 *     wrote it as the human-readable table of contents for that level;
 *   - otherwise synthesise the listing from the index: child directories with
 *     concept counts, and child pages with their one-line descriptions;
 *   - at the corpus root, do the same for the bundles themselves.
 *
 * Synthesis is capped. A directory with a thousand children produces a listing
 * that is itself unreadable, which defeats the point of a discovery tool.
 */

import fs from "node:fs";
import path from "node:path";

import { INDEX_FILENAME, MAX_LISTING_ENTRIES } from "../constants.js";
import { resolveWithinRoot } from "./safe-path.js";
import { readConcept, type CorpusIndex } from "./store.js";

export interface ListingEntry {
  /** Directory name, or the page's full concept id. */
  name: string;
  /** Corpus-relative path to hand to `list_docs` or `read_doc`. */
  conceptId: string;
  title: string;
  description: string;
  type: string;
  /** For a directory: how many concepts are underneath it. */
  conceptCount?: number;
}

export interface BrowseResult {
  kind: "index" | "document" | "listing";
  bundle: string | null;
  /** Corpus-relative posix path this describes; "" is the corpus root. */
  path: string;
  /** Set when a file was returned. */
  conceptId: string | null;
  frontmatter: Record<string, unknown> | null;
  body: string | null;
  truncated: boolean;
  /** Body length before truncation, so a caller can state what was cut. */
  totalChars: number;
  directories: ListingEntry[];
  pages: ListingEntry[];
  /** Entries that existed before the cap was applied. */
  total: number;
  truncatedEntries: number;
  /** A human-readable explanation of anything unusual. */
  note: string | null;
}

export interface BrowseOptions {
  bundle?: string;
  path?: string;
  allowedBundles: readonly string[];
  maxChars: number;
}

function emptyResult(overrides: Partial<BrowseResult>): BrowseResult {
  return {
    kind: "listing",
    bundle: null,
    path: "",
    conceptId: null,
    frontmatter: null,
    body: null,
    truncated: false,
    totalChars: 0,
    directories: [],
    pages: [],
    total: 0,
    truncatedEntries: 0,
    note: null,
    ...overrides,
  };
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/** Return a file's content as a browse result, or null when there is none. */
async function fileResult(
  root: string,
  conceptId: string,
  maxChars: number,
  kind: "index" | "document",
): Promise<BrowseResult | null> {
  const read = await readConcept(root, conceptId, { maxChars });
  if (!read.ok) return null;
  return emptyResult({
    kind,
    bundle: read.concept.bundle,
    path: path.posix.dirname(conceptId) === "." ? "" : path.posix.dirname(conceptId),
    conceptId,
    frontmatter: read.concept.frontmatter,
    body: read.concept.body,
    truncated: read.concept.truncated,
    totalChars: read.concept.totalChars,
  });
}

/** True when `candidate` is a directory on disk. */
async function isDirectory(root: string, relative: string): Promise<boolean> {
  try {
    const absolute = resolveWithinRoot(root, relative);
    const stat = await fs.promises.stat(absolute);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Synthesise the listing of one directory from the in-memory index.
 *
 * Reading the index rather than the filesystem is what keeps this cheap, and it
 * also means the listing agrees with what search will return — a name shown here
 * is a name `read_doc` can open.
 */
function synthesize(
  index: CorpusIndex,
  prefix: string,
  bundle: string | null,
  relativePath: string,
): BrowseResult {
  const withPrefix = index.concepts.filter((record) => record.conceptId.startsWith(prefix));

  const pageEntries: ListingEntry[] = [];
  const dirNames = new Set<string>();

  for (const record of withPrefix) {
    const remainder = record.conceptId.slice(prefix.length);
    if (remainder.length === 0) continue;
    const slash = remainder.indexOf("/");
    if (slash === -1) {
      // A page at this level. The directory's own index.md is represented by the
      // returned index document, not repeated as a child.
      if (remainder === INDEX_FILENAME) continue;
      pageEntries.push({
        name: remainder,
        conceptId: record.conceptId,
        title: record.title,
        description: record.description,
        type: record.type,
      });
      continue;
    }
    dirNames.add(remainder.slice(0, slash));
  }

  const directoryEntries: ListingEntry[] = [...dirNames]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const childPrefix = `${prefix}${name}/`;
      const count = index.concepts.filter((record) =>
        record.conceptId.startsWith(childPrefix),
      ).length;
      const childId = `${childPrefix}${INDEX_FILENAME}`;
      const hasIndex = index.concepts.some((record) => record.conceptId === childId);
      return {
        name,
        // Point at the child's index when it has one, so the next call returns
        // the builder's own table of contents rather than a synthesised list.
        conceptId: hasIndex ? childId : childPrefix.replace(/\/$/, ""),
        title: name,
        description: "",
        type: "",
        conceptCount: count,
      };
    });

  pageEntries.sort((a, b) => a.title.localeCompare(b.title) || a.name.localeCompare(b.name));

  const all = [...directoryEntries, ...pageEntries];
  const capped = all.slice(0, MAX_LISTING_ENTRIES);

  return emptyResult({
    kind: "listing",
    bundle,
    path: relativePath,
    directories: capped.filter((entry) => entry.conceptCount !== undefined),
    pages: capped.filter((entry) => entry.conceptCount === undefined),
    total: all.length,
    truncatedEntries: all.length - capped.length,
    note: null,
  });
}

/** Bundle inventory for the corpus root when there is no root `index.md`. */
function bundleListing(index: CorpusIndex, allowed: readonly string[]): BrowseResult {
  const permitted = new Set(allowed);
  const bundles = index.bundles.filter(
    (bundle) => permitted.size === 0 || permitted.has(bundle.name),
  );
  const entries: ListingEntry[] = bundles.map((bundle) => {
    const indexId = `${bundle.name}/${INDEX_FILENAME}`;
    const hasIndex = index.concepts.some((record) => record.conceptId === indexId);
    return {
      name: bundle.name,
      // A bundle without an index.md is browsed as a directory; pointing at a
      // file that does not exist would turn the next call into a miss.
      conceptId: hasIndex ? indexId : bundle.name,
      title: bundle.name,
      description: "",
      type: "",
      conceptCount: bundle.conceptCount,
    };
  });

  // Markdown sitting directly in the corpus root is a page, not a bundle. The
  // real corpus has an `index.md` (handled above); a flat corpus has pages.
  // An active allowlist excludes them, exactly as search excludes bundle `""`.
  const rootPages: ListingEntry[] = index.concepts
    .filter((record) => record.bundle === "" && permitted.size === 0)
    .map((record) => ({
      name: record.conceptId,
      conceptId: record.conceptId,
      title: record.title,
      description: record.description,
      type: record.type,
    }))
    .sort((a, b) => a.conceptId.localeCompare(b.conceptId));

  const cappedDirs = entries.slice(0, MAX_LISTING_ENTRIES);
  const cappedPages = rootPages.slice(0, Math.max(0, MAX_LISTING_ENTRIES - cappedDirs.length));
  const total = entries.length + rootPages.length;
  const shown = cappedDirs.length + cappedPages.length;

  return emptyResult({
    kind: "listing",
    bundle: null,
    path: "",
    directories: cappedDirs,
    pages: cappedPages,
    total,
    truncatedEntries: total - shown,
    note:
      total === 0
        ? "The corpus root has no readable bundles."
        : "No root index.md; this is a synthesised bundle listing.",
  });
}

/**
 * Resolve one `list_docs` call.
 *
 * Throws `PathRefusal` when the path escapes the corpus; the tool handler turns
 * that into a refusal result. A missing directory is not an error — it is a
 * listing with an explanatory `note`.
 */
export async function browseCorpus(
  index: CorpusIndex,
  root: string,
  options: BrowseOptions,
): Promise<BrowseResult> {
  const permitted = new Set(options.allowedBundles);
  const knownBundles = new Set(index.bundles.map((bundle) => bundle.name));

  const rawBundle = options.bundle?.trim() ?? "";
  const rawPath = options.path?.trim() ?? "";

  // Validate the caller's paths *before* interpreting them.
  //
  // The convenience below — a `path` whose first segment is the bundle — is
  // exactly what would otherwise turn `path: "../etc"` into a bundle literally
  // named "..", answered with a friendly "no bundle named .." note instead of a
  // refusal. `resolveWithinRoot` throws `PathRefusal`, which the tool handler
  // reports as a refusal.
  if (rawBundle.length > 0) resolveWithinRoot(root, rawBundle);
  if (rawPath.length > 0) resolveWithinRoot(root, rawPath);

  // `path` without `bundle` is accepted and split, so `list_docs({ path:
  // "n8n/docs.n8n.io" })` works. Refusing it would be a papercut with no safety
  // benefit — the path has already been validated against the root.
  let bundle = rawBundle;
  let relative = rawPath;
  if (bundle.length === 0 && relative.length > 0) {
    const segments = relative.split(/[\\/]+/).filter((segment) => segment.length > 0);
    const first = segments.shift() ?? "";
    bundle = first;
    relative = segments.join("/");
  }

  if (bundle.length === 0) {
    // The corpus root. An index.md here is the builder's own entry point.
    const indexFile = await fileResult(root, INDEX_FILENAME, options.maxChars, "index");
    if (indexFile) return indexFile;
    return bundleListing(index, options.allowedBundles);
  }

  if (permitted.size > 0 && !permitted.has(bundle)) {
    return emptyResult({
      kind: "listing",
      bundle,
      path: relative,
      note: `the bundle "${bundle}" is not in this instance's allowedBundles`,
    });
  }
  if (!knownBundles.has(bundle)) {
    return emptyResult({
      kind: "listing",
      bundle,
      path: relative,
      note: `no bundle named "${bundle}" exists in the corpus`,
    });
  }

  const suffix = relative.length > 0 ? `/${toPosix(relative)}` : "";

  // A path that names a file returns that file. `index.md` is the format's
  // table of contents; any other page is returned as a document, because
  // refusing to open what the caller explicitly named would be perverse.
  if (relative.length > 0 && relative.toLowerCase().endsWith(".md")) {
    const conceptId = `${bundle}${suffix}`;
    const asIndex = conceptId.endsWith(`/${INDEX_FILENAME}`) || conceptId === `${bundle}/${INDEX_FILENAME}`;
    const file = await fileResult(root, conceptId, options.maxChars, asIndex ? "index" : "document");
    if (file) return file;
    return emptyResult({
      kind: "listing",
      bundle,
      path: relative,
      conceptId,
      note: `no page exists at ${conceptId}`,
    });
  }

  const directoryId = `${bundle}${suffix}`;
  if (!(await isDirectory(root, directoryId))) {
    return emptyResult({
      kind: "listing",
      bundle,
      path: relative,
      note: `no directory exists at ${directoryId}`,
    });
  }

  // The index.md is the format's progressive-disclosure mechanism; prefer it.
  const indexId = `${directoryId}/${INDEX_FILENAME}`;
  const indexFile = await fileResult(root, indexId, options.maxChars, "index");
  if (indexFile) return indexFile;

  return synthesize(
    index,
    `${directoryId}/`,
    bundle,
    relative.length > 0 ? toPosix(relative) : "",
  );
}
