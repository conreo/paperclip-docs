/**
 * The corpus index.
 *
 * ## Why an index exists at all
 *
 * The corpus is ~10,500 files and ~80 MB. A search that stat'd and read every
 * file would read 80 MB per request, and an agent that searches three times
 * would read it three times. So the first call walks the corpus once, parses
 * every concept, and keeps a compact record per file; later calls answer from
 * memory.
 *
 * ## What is cached, and what is not
 *
 * A record holds the parsed metadata, the headings, a bounded body prefix (for
 * ranking and snippets) and a lower-cased copy of the same text (for matching).
 * The body prefix is capped by `MAX_INDEX_BODY_CHARS`, so the index's size per
 * concept is constant — it does not grow with the corpus. `read_doc` never
 * serves from this cache: it re-reads the one file it needs, because that is
 * both cheap and the only way truncation can be applied to the *real* document
 * rather than to the indexed prefix.
 *
 * ## Invalidation
 *
 * A static artifact still gets rebuilt, and a stale index is a citation to a
 * page that no longer says what the agent was told. The corpus signature is the
 * root's `mtime` plus every bundle directory's `mtime` and entry count — about
 * fifteen `stat` calls, so checking it on every request is effectively free,
 * while a rebuild (which rewrites those directories) changes it immediately.
 * This deliberately does not walk the tree to detect a single edited file: that
 * would be the 80 MB read the index exists to avoid, and editing a build
 * artifact by hand is not a supported workflow.
 */

import fs from "node:fs";
import path from "node:path";

import {
  BUILD_MANIFEST_FILENAMES,
  CORPUS_AGE_WARNING_DAYS,
  INDEX_FILENAME,
  MAX_INDEX_BODY_CHARS,
  MAX_INDEX_HEADINGS,
} from "../constants.js";
import {
  displayTitle,
  extractHeadings,
  normalizeTags,
  normalizeTimestamp,
  parseFrontmatter,
  stringField,
} from "./frontmatter.js";
import { isContainedIn, resolveWithinRoot } from "./safe-path.js";

/** Raised when the configured corpus root cannot be read at all. */
export class CorpusUnavailable extends Error {
  constructor(
    readonly reason: "missing" | "not_a_directory" | "unreadable",
    message: string,
  ) {
    super(message);
    this.name = "CorpusUnavailable";
  }
}

/** One concept, as held in memory. */
export interface ConceptRecord {
  /** Path relative to the corpus root, using `/`, e.g. `n8n/index.md`. */
  conceptId: string;
  /** The top-level directory the concept lives in. */
  bundle: string;
  title: string;
  type: string;
  description: string;
  resource: string | null;
  tags: string[];
  timestamp: string | null;
  headings: string[];
  /** Body text, capped, used for snippets. */
  bodyPreview: string;
  /** Lower-cased title, for scoring. */
  titleLower: string;
  descriptionLower: string;
  tagsLower: string;
  headingsLower: string;
  /** Lower-cased body prefix, for scoring. */
  bodyLower: string;
  /** A frontmatter parse failure, kept so `sources` can report corpus health. */
  frontmatterError: string | null;
}

export interface BundleSummary {
  name: string;
  conceptCount: number;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
}

export interface CorpusIndex {
  root: string;
  /** The mtime signature this index was built from. */
  signature: string;
  builtAtMs: number;
  concepts: ConceptRecord[];
  bundles: BundleSummary[];
  totalConcepts: number;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
  /** Files under the root that could not be read or were skipped. */
  skipped: number;
  /** A build manifest, when the builder wrote one. */
  manifest: Record<string, unknown> | null;
  manifestPath: string | null;
  /** Set when the manifest exists but could not be parsed. */
  manifestError: string | null;
}

/** What `sources` and the settings page report. */
export interface CorpusStatus {
  root: string;
  exists: boolean;
  totalConcepts: number;
  bundles: BundleSummary[];
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
  /** Age of the newest concept, in whole days, or null when unknown. */
  ageDays: number | null;
  /** True when the newest concept is older than the warning threshold. */
  stale: boolean;
  manifest: Record<string, unknown> | null;
  manifestPath: string | null;
  skipped: number;
  /** A read or parse failure that stopped the index being built. */
  error: string | null;
}

const DAY_MS = 86_400_000;

/** How many files are read at once while building. Bounded, but not serial. */
const READ_CONCURRENCY = 64;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/** The bundle directories directly under the root, sorted, hidden ones excluded. */
async function bundleEntries(root: string): Promise<fs.Dirent[]> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A cheap fingerprint of the corpus's on-disk shape.
 *
 * `mtimeMs` moves when a directory is rewritten, which is exactly what a rebuild
 * does. `size` is a second signal on filesystems with coarse timestamps. The
 * entry count catches an in-place addition on such a filesystem too.
 */
export async function corpusSignature(root: string): Promise<string> {
  let rootStat: fs.Stats;
  try {
    rootStat = await fs.promises.stat(root);
  } catch {
    throw new CorpusUnavailable(
      "missing",
      `the corpus directory does not exist: ${root}`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new CorpusUnavailable(
      "not_a_directory",
      `the corpus root is not a directory: ${root}`,
    );
  }

  const parts: string[] = [`root:${rootStat.mtimeMs}`];
  let entries: fs.Dirent[];
  try {
    entries = await bundleEntries(root);
  } catch (error) {
    throw new CorpusUnavailable(
      "unreadable",
      `the corpus directory could not be listed: ${root} (${String(error)})`,
    );
  }
  for (const entry of entries) {
    try {
      const stat = await fs.promises.stat(path.join(root, entry.name));
      parts.push(`${entry.name}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${entry.name}:unreadable`);
    }
  }
  return parts.join("|");
}

/** Read and parse one concept file into its index record. */
function buildRecord(
  bundle: string,
  conceptId: string,
  raw: string,
): ConceptRecord {
  const parsed = parseFrontmatter(raw);
  const frontmatter = parsed.frontmatter;

  const title = displayTitle(frontmatter["title"], parsed.body, conceptId);
  const description = stringField(frontmatter["description"]);
  const tags = normalizeTags(frontmatter["tags"]);
  const headings = extractHeadings(parsed.body, MAX_INDEX_HEADINGS);
  const bodyPreview = parsed.body.slice(0, MAX_INDEX_BODY_CHARS);
  const tagsJoined = tags.join(" ");
  const headingsJoined = headings.join(" ");

  return {
    conceptId,
    bundle,
    title,
    type: stringField(frontmatter["type"]),
    description,
    resource: stringField(frontmatter["resource"]) || null,
    tags,
    timestamp: normalizeTimestamp(frontmatter["timestamp"]),
    headings,
    bodyPreview,
    titleLower: title.toLowerCase(),
    descriptionLower: description.toLowerCase(),
    tagsLower: tagsJoined.toLowerCase(),
    headingsLower: headingsJoined.toLowerCase(),
    bodyLower: bodyPreview.toLowerCase(),
    frontmatterError: parsed.error,
  };
}

/** Find a build manifest, if the builder wrote one. */
async function readManifest(root: string): Promise<{
  manifest: Record<string, unknown> | null;
  manifestPath: string | null;
  manifestError: string | null;
}> {
  for (const name of BUILD_MANIFEST_FILENAMES) {
    const candidate = path.join(root, name);
    let raw: string;
    try {
      const stat = await fs.promises.stat(candidate);
      if (!stat.isFile()) continue;
      raw = await fs.promises.readFile(candidate, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return {
          manifest: parsed as Record<string, unknown>,
          manifestPath: name,
          manifestError: null,
        };
      }
      return { manifest: null, manifestPath: name, manifestError: "manifest is not a JSON object" };
    } catch (error) {
      return {
        manifest: null,
        manifestPath: name,
        manifestError: `manifest could not be parsed: ${String(error)}`,
      };
    }
  }
  return { manifest: null, manifestPath: null, manifestError: null };
}

/** Walk one bundle directory, returning every `.md` file as a corpus-relative id. */
async function walkBundle(
  root: string,
  realRoot: string,
  bundle: string,
): Promise<{ conceptIds: string[]; skipped: number }> {
  const conceptIds: string[] = [];
  let skipped = 0;
  const stack: string[] = [bundle];

  while (stack.length > 0) {
    const relativeDir = stack.pop();
    if (relativeDir === undefined) break;
    const absoluteDir = path.join(root, relativeDir);

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      skipped += 1;
      continue;
    }

    for (const entry of entries) {
      const relative = `${relativeDir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        // A symlink inside the corpus can point outside it. `resolveWithinRoot`
        // refuses those at read time, but walking through one here would put
        // out-of-corpus files into the index in the first place, so the link is
        // checked before it is followed.
        let real: string;
        try {
          real = await fs.promises.realpath(path.join(root, relative));
        } catch {
          skipped += 1;
          continue;
        }
        if (!isContainedIn(realRoot, real)) {
          skipped += 1;
          continue;
        }
      }

      if (entry.isDirectory() || (entry.isSymbolicLink() && !entry.name.endsWith(".md"))) {
        stack.push(relative);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      conceptIds.push(toPosix(relative));
    }
  }

  return { conceptIds, skipped };
}

async function buildIndex(root: string, signature: string): Promise<CorpusIndex> {
  const realRoot = await fs.promises.realpath(root);
  const bundles = await bundleEntries(root);

  let skipped = 0;
  const perBundle: Array<{ name: string; conceptIds: string[] }> = [];
  for (const entry of bundles) {
    // The same symlink rule that applies inside a bundle applies to the bundle
    // directory itself: `corpus/escape -> /etc` must not be walked just because
    // the link sits at the top level. Checking it here is what stops the index
    // being built from files the reader would later refuse.
    if (entry.isSymbolicLink()) {
      try {
        const real = await fs.promises.realpath(path.join(root, entry.name));
        if (!isContainedIn(realRoot, real)) {
          skipped += 1;
          continue;
        }
      } catch {
        skipped += 1;
        continue;
      }
    }
    const walked = await walkBundle(root, realRoot, entry.name);
    skipped += walked.skipped;
    perBundle.push({ name: entry.name, conceptIds: walked.conceptIds });
  }

  const allIds: Array<{ bundle: string; conceptId: string }> = [];
  for (const bundle of perBundle) {
    for (const conceptId of bundle.conceptIds) {
      allIds.push({ bundle: bundle.name, conceptId });
    }
  }

  // Markdown directly in the corpus root, which is not part of any bundle. The
  // real corpus ships an `index.md` there, and a flat corpus may be nothing but
  // files; ignoring them would make a valid corpus index as empty. Their bundle
  // name is the empty string, and an `allowedBundles` allowlist excludes them
  // for the same reason it excludes any other bundle the operator did not name.
  try {
    const rootEntries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (!entry.name.endsWith(".md") || entry.isDirectory()) continue;
      if (entry.isSymbolicLink()) {
        try {
          const real = await fs.promises.realpath(path.join(root, entry.name));
          if (!isContainedIn(realRoot, real)) {
            skipped += 1;
            continue;
          }
        } catch {
          skipped += 1;
          continue;
        }
      }
      allIds.push({ bundle: "", conceptId: entry.name });
    }
  } catch {
    skipped += 1;
  }

  const records = await mapLimit(allIds, READ_CONCURRENCY, async ({ bundle, conceptId }) => {
    try {
      const raw = await fs.promises.readFile(path.join(root, conceptId), "utf8");
      return buildRecord(bundle, conceptId, raw);
    } catch {
      // An unreadable file is a gap in the corpus, not a failure of the search:
      // counting it and moving on is what keeps one bad file from taking the
      // whole index down.
      return null;
    }
  });

  const concepts = records.filter((record): record is ConceptRecord => record !== null);
  skipped += records.length - concepts.length;

  let oldestTimestamp: string | null = null;
  let newestTimestamp: string | null = null;
  let oldestMs = Number.POSITIVE_INFINITY;
  let newestMs = Number.NEGATIVE_INFINITY;

  const summarize = (name: string, recordsInBundle: ConceptRecord[]): BundleSummary => {
    let bundleOldest: string | null = null;
    let bundleNewest: string | null = null;
    let bundleOldestMs = Number.POSITIVE_INFINITY;
    let bundleNewestMs = Number.NEGATIVE_INFINITY;
    for (const record of recordsInBundle) {
      if (record.timestamp === null) continue;
      const ms = Date.parse(record.timestamp);
      if (!Number.isFinite(ms)) continue;
      if (ms < bundleOldestMs) {
        bundleOldestMs = ms;
        bundleOldest = record.timestamp;
      }
      if (ms > bundleNewestMs) {
        bundleNewestMs = ms;
        bundleNewest = record.timestamp;
      }
    }
    if (bundleOldestMs < oldestMs) {
      oldestMs = bundleOldestMs;
      oldestTimestamp = bundleOldest;
    }
    if (bundleNewestMs > newestMs) {
      newestMs = bundleNewestMs;
      newestTimestamp = bundleNewest;
    }
    return {
      name,
      conceptCount: recordsInBundle.length,
      oldestTimestamp: bundleOldest,
      newestTimestamp: bundleNewest,
    };
  };

  const bundleSummaries: BundleSummary[] = [];
  for (const bundle of perBundle) {
    bundleSummaries.push(
      summarize(
        bundle.name,
        concepts.filter((record) => record.bundle === bundle.name),
      ),
    );
  }

  const manifest = await readManifest(root);

  return {
    root,
    signature,
    builtAtMs: Date.now(),
    concepts,
    bundles: bundleSummaries,
    totalConcepts: concepts.length,
    oldestTimestamp,
    newestTimestamp,
    skipped,
    manifest: manifest.manifest,
    manifestPath: manifest.manifestPath,
    manifestError: manifest.manifestError,
  };
}

/**
 * Holds one index per corpus root, keyed by the root's on-disk signature.
 *
 * One store per worker process. The in-flight promise is cached too, so ten
 * simultaneous first calls build the index once rather than ten times.
 */
export class CorpusStore {
  private readonly entries = new Map<
    string,
    { signature: string; promise: Promise<CorpusIndex> }
  >();

  async load(root: string, options: { force?: boolean } = {}): Promise<CorpusIndex> {
    const signature = await corpusSignature(root);
    const cached = this.entries.get(root);
    if (!options.force && cached && cached.signature === signature) {
      return cached.promise;
    }

    const promise = buildIndex(root, signature).catch((error: unknown) => {
      // A failed build must not be cached: the next call should retry rather
      // than inherit the failure for the life of the process.
      const current = this.entries.get(root);
      if (current?.promise === promise) this.entries.delete(root);
      throw error;
    });

    this.entries.set(root, { signature, promise });
    return promise;
  }

  /** Drop the cached index for one root, or all of them. */
  invalidate(root?: string): void {
    if (root === undefined) this.entries.clear();
    else this.entries.delete(root);
  }

  /** How many roots are currently indexed; used by health reporting. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Report the corpus's state without throwing on a missing root.
   *
   * The settings page and the `sources` tool both exist partly to answer "why is
   * this not working?", so a missing directory is data here, not an exception.
   */
  async describe(root: string, options: { now?: number } = {}): Promise<CorpusStatus> {
    let index: CorpusIndex;
    try {
      index = await this.load(root);
    } catch (error) {
      const message =
        error instanceof CorpusUnavailable
          ? error.message
          : `the corpus could not be indexed: ${String(error)}`;
      return {
        root,
        exists: false,
        totalConcepts: 0,
        bundles: [],
        oldestTimestamp: null,
        newestTimestamp: null,
        ageDays: null,
        stale: false,
        manifest: null,
        manifestPath: null,
        skipped: 0,
        error: message,
      };
    }

    const now = options.now ?? Date.now();
    const newestMs = index.newestTimestamp === null ? null : Date.parse(index.newestTimestamp);
    const ageDays =
      newestMs === null || !Number.isFinite(newestMs)
        ? null
        : Math.floor((now - newestMs) / DAY_MS);

    return {
      root: index.root,
      exists: true,
      totalConcepts: index.totalConcepts,
      bundles: index.bundles,
      oldestTimestamp: index.oldestTimestamp,
      newestTimestamp: index.newestTimestamp,
      ageDays,
      // `>` rather than `>=`: a document exactly 90 days old is at the boundary
      // the setting names, and warning on the boundary makes the number look
      // wrong ("90 days old" flagged as "more than 90 days").
      stale: ageDays !== null && ageDays > CORPUS_AGE_WARNING_DAYS,
      manifest: index.manifest,
      manifestPath: index.manifestPath,
      skipped: index.skipped,
      error: null,
    };
  }
}

/** A concept read back from disk, for `read_doc`. */
export interface ReadConceptResult {
  conceptId: string;
  bundle: string;
  title: string;
  type: string;
  description: string;
  resource: string | null;
  tags: string[];
  timestamp: string | null;
  frontmatter: Record<string, unknown>;
  /** The body, already cut to the caller's cap when it was longer. */
  body: string;
  /** Length of the body before any truncation, so the marker can state it. */
  totalChars: number;
  /** True when the body was longer than the caller's cap. */
  truncated: boolean;
  frontmatterError: string | null;
}

export type ReadConceptOutcome =
  | { ok: true; concept: ReadConceptResult }
  | { ok: false; code: "not_found" | "not_a_file" | "refused" | "unreadable"; message: string };

/**
 * Read one concept from disk.
 *
 * Deliberately not served from the index: the index holds a capped prefix, and a
 * reader that returned that prefix would silently cut off long pages while
 * claiming to return the full document.
 */
export async function readConcept(
  root: string,
  conceptId: string,
  options: { maxChars: number },
): Promise<ReadConceptOutcome> {
  let absolute: string;
  try {
    // Throws `PathRefusal` for anything that leaves the root; the caller turns
    // that into a refusal, never a read.
    absolute = resolveWithinRoot(root, conceptId);
  } catch (error) {
    return {
      ok: false,
      code: "refused",
      message: error instanceof Error ? error.message : "the corpus path was refused",
    };
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absolute);
  } catch {
    return {
      ok: false,
      code: "not_found",
      message: `no concept exists at ${conceptId}`,
    };
  }
  if (stat.isDirectory()) {
    return {
      ok: false,
      code: "not_a_file",
      message: `${conceptId} is a directory; use list_docs to see what it contains`,
    };
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(absolute, "utf8");
  } catch {
    return {
      ok: false,
      code: "unreadable",
      message: `${conceptId} exists but could not be read`,
    };
  }

  const parsed = parseFrontmatter(raw);
  const firstSegment = conceptId.split("/")[0] ?? "";
  const body =
    parsed.body.length > options.maxChars
      ? parsed.body.slice(0, options.maxChars)
      : parsed.body;

  return {
    ok: true,
    concept: {
      conceptId,
      bundle: firstSegment,
      title: displayTitle(parsed.frontmatter["title"], parsed.body, conceptId),
      type: stringField(parsed.frontmatter["type"]),
      description: stringField(parsed.frontmatter["description"]),
      resource: stringField(parsed.frontmatter["resource"]) || null,
      tags: normalizeTags(parsed.frontmatter["tags"]),
      timestamp: normalizeTimestamp(parsed.frontmatter["timestamp"]),
      frontmatter: parsed.frontmatter,
      body,
      totalChars: parsed.body.length,
      truncated: parsed.body.length > options.maxChars,
      frontmatterError: parsed.error,
    },
  };
}

/** The progressive-disclosure filename, re-exported for callers that build paths. */
export { INDEX_FILENAME };
