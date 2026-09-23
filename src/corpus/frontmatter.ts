/**
 * Parsing an OKF concept.
 *
 * An OKF concept is a markdown file with a YAML frontmatter block:
 *
 *     ---
 *     type: Guide
 *     title: "Transfer Ownership"
 *     description: "- Files & synchronization"
 *     resource: https://docs.nextcloud.com/…
 *     tags: [nextcloud]
 *     timestamp: 2026-07-03T02:22:34Z
 *     ---
 *
 *     <body>
 *
 * ## Why this does not pull in a YAML library
 *
 * The corpus is a build artifact with a known, narrow shape: flat scalar keys and
 * flow sequences. A general YAML parser would be a runtime dependency in the
 * worker for a grammar the corpus does not use, and — more importantly — a real
 * parser *throws or silently coerces* on the malformed input this module exists
 * to survive. The parser below understands exactly the subset OKF produces,
 * records where it gave up, and never throws: a concept with broken frontmatter
 * must still be listed, searched by its body, and readable.
 *
 * ## What "degrade gracefully" means here
 *
 * Four failures are real in this corpus and each has a defined outcome:
 *
 *   - **missing frontmatter** — the whole file is body; title falls back to the
 *     first heading, then the filename. `index.md` files legitimately look like
 *     this.
 *   - **malformed YAML** — the fields that parsed are kept, the error is stored
 *     on the record, and the body is not affected.
 *   - **tags as a string** rather than a list — accepted as a one-element list
 *     (comma-separated values are split), because a single-tag document is more
 *     likely than a deliberately hostile one.
 *   - **an empty body** — a valid concept; it simply contributes no body text.
 */

/** The outcome of reading one concept file. */
export interface ParsedDocument {
  /** Parsed frontmatter keys. Empty when there was none or it was unreadable. */
  frontmatter: Record<string, unknown>;
  /** True when the file opened with a `---` delimiter. */
  hasFrontmatter: boolean;
  /** Everything after the frontmatter block, with at most one leading blank line removed. */
  body: string;
  /** A human-readable parse failure, or null. Never thrown. */
  error: string | null;
}

interface YamlSubsetResult {
  fields: Record<string, unknown>;
  error: string | null;
}

/**
 * Keys OKF defines. Anything else is kept anyway — an unknown key is harmless to
 * carry — but knowing the set lets `normalizeMetadata` read them without casts.
 */
const FRONTMATTER_KEY = /^([A-Za-z0-9_.-]+):(?:[ \t]*(.*))?$/;
const SEQUENCE_ITEM = /^[ \t]*-[ \t]*(.*)$/;

/** Parse one scalar value from the OKF subset, or throw a message. */
function parseScalar(input: string): unknown {
  // A `#` preceded by whitespace starts a comment; a `#` inside a URL does not,
  // which is why the plain-scalar branch strips comments rather than the caller.
  const text = input.trim();
  if (text.length === 0) return null;

  if (text.startsWith('"')) return parseDoubleQuoted(text);
  if (text.startsWith("'")) return parseSingleQuoted(text);
  if (text.startsWith("[")) return parseFlowSequence(text);

  const plain = text.replace(/[ \t]+#.*$/, "").trim();
  if (plain === "" || plain === "~" || plain === "null") return null;
  if (plain === "true") return true;
  if (plain === "false") return false;
  if (/^-?\d+$/.test(plain)) return Number.parseInt(plain, 10);
  if (/^-?\d+\.\d+$/.test(plain)) return Number.parseFloat(plain);
  return plain;
}

function parseDoubleQuoted(text: string): string {
  let out = "";
  for (let i = 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") {
      const next = text[i + 1];
      // Only the escapes the corpus can contain are interpreted; an unknown
      // escape keeps the backslash rather than losing data.
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === '"') out += '"';
      else if (next === "\\") out += "\\";
      else out += `\\${next ?? ""}`;
      i += 1;
      continue;
    }
    if (char === '"') {
      // Trailing content after the closing quote is tolerated only when it is a
      // comment; anything else means the value was not what it claimed.
      const rest = text.slice(i + 1).trim();
      if (rest.length > 0 && !rest.startsWith("#")) {
        throw new Error(`unexpected text after a quoted value: ${rest.slice(0, 40)}`);
      }
      return out;
    }
    out += char;
  }
  throw new Error("unterminated double-quoted string");
}

function parseSingleQuoted(text: string): string {
  let out = "";
  for (let i = 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i += 1;
        continue;
      }
      const rest = text.slice(i + 1).trim();
      if (rest.length > 0 && !rest.startsWith("#")) {
        throw new Error(`unexpected text after a quoted value: ${rest.slice(0, 40)}`);
      }
      return out;
    }
    out += char;
  }
  throw new Error("unterminated single-quoted string");
}

function parseFlowSequence(text: string): unknown[] {
  const end = text.lastIndexOf("]");
  if (end === -1) throw new Error("unterminated flow sequence (missing `]`)");
  const trailing = text.slice(end + 1).trim();
  if (trailing.length > 0 && !trailing.startsWith("#")) {
    throw new Error(`unexpected text after a flow sequence: ${trailing.slice(0, 40)}`);
  }
  const inner = text.slice(1, end).trim();
  if (inner.length === 0) return [];

  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("unterminated quote inside a flow sequence");
  items.push(current);

  return items.map((item) => parseScalar(item));
}

/**
 * The OKF frontmatter subset: flat `key: value` pairs and block sequences.
 *
 * Returns the fields that parsed plus the *first* error encountered, rather than
 * throwing, so one bad line cannot discard a document's other metadata.
 */
function parseYamlSubset(text: string): YamlSubsetResult {
  const fields: Record<string, unknown> = {};
  let error: string | null = null;
  let pendingKey: string | null = null;
  let pendingList: unknown[] = [];

  const commitPending = (): void => {
    if (pendingKey !== null) {
      fields[pendingKey] = pendingList;
      pendingKey = null;
      pendingList = [];
    }
  };

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    if (/^[ \t]*#/.test(line)) continue;

    // A block-sequence item belongs to whatever key opened it.
    const sequence = SEQUENCE_ITEM.exec(line);
    if (sequence && pendingKey !== null) {
      try {
        pendingList.push(parseScalar(sequence[1] ?? ""));
      } catch (thrown) {
        error ??= `line ${index + 1}: ${message(thrown)}`;
      }
      continue;
    }

    const pair = FRONTMATTER_KEY.exec(line);
    if (pair) {
      commitPending();
      const key = pair[1] ?? "";
      const value = (pair[2] ?? "").trim();
      if (value.length === 0) {
        // `key:` with nothing after it opens a block sequence.
        pendingKey = key;
        pendingList = [];
        continue;
      }
      try {
        fields[key] = parseScalar(value);
      } catch (thrown) {
        error ??= `line ${index + 1}: ${message(thrown)}`;
      }
      continue;
    }

    // Anything else (a nested map, a tab-indented fragment) is unsupported. It
    // is recorded once and skipped: the rest of the document may still parse.
    error ??= `line ${index + 1}: unsupported frontmatter syntax`;
  }

  commitPending();
  return { fields, error };
}

function message(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** Parse a whole concept file. Never throws, whatever the bytes contain. */
export function parseFrontmatter(raw: string): ParsedDocument {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  let open = 0;
  while (open < lines.length && (lines[open] ?? "").trim() === "") open += 1;

  if (open >= lines.length || (lines[open] ?? "").trim() !== "---") {
    return { frontmatter: {}, hasFrontmatter: false, body: text, error: null };
  }

  let close = -1;
  for (let index = open + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === "---") {
      close = index;
      break;
    }
  }

  if (close === -1) {
    return {
      frontmatter: {},
      hasFrontmatter: true,
      body: lines.slice(open + 1).join("\n"),
      error: "frontmatter opened with `---` but never closed",
    };
  }

  const { fields, error } = parseYamlSubset(lines.slice(open + 1, close).join("\n"));

  let body = lines.slice(close + 1).join("\n");
  if (body.startsWith("\n")) body = body.slice(1);

  return { frontmatter: fields, hasFrontmatter: true, body, error };
}

/**
 * Coerce a frontmatter `tags` value into a list of strings.
 *
 * Accepts a list, a single string, or a comma-separated string. Drops anything
 * that is not a string rather than throwing: a document with one bad tag is
 * still a document.
 */
export function normalizeTags(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Validate a frontmatter timestamp.
 *
 * Only a value that actually parses as a date is returned. A garbled timestamp
 * is worse than none: `sources` reports the corpus's age from these, and a
 * string that sorts as "newest" while meaning nothing would make the snapshot
 * look fresher than it is.
 */
export function normalizeTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? trimmed : null;
}

/** Every ATX heading in a body, in document order, capped. */
export function extractHeadings(body: string, max: number): string[] {
  const headings: string[] = [];
  const pattern = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  for (const match of body.matchAll(pattern)) {
    const text = (match[1] ?? "").trim();
    if (text.length > 0) headings.push(text);
    if (headings.length >= max) break;
  }
  return headings;
}

/** The first ATX heading, or null. */
export function firstHeading(body: string): string | null {
  return extractHeadings(body, 1)[0] ?? null;
}

/**
 * A readable title when the frontmatter has none.
 *
 * `Untitled` is treated as absent because the build emits it by the thousand —
 * search results titled "Untitled" are indistinguishable. In that case the
 * first heading is a far better label, and the filename is the last resort.
 */
export function displayTitle(
  frontmatterTitle: unknown,
  body: string,
  conceptId: string,
): string {
  if (typeof frontmatterTitle === "string") {
    const trimmed = frontmatterTitle.trim();
    if (trimmed.length > 0 && !/^untitled$/i.test(trimmed)) return trimmed;
  }
  const heading = firstHeading(body);
  if (heading) return heading;
  const base = conceptId.split("/").pop() ?? conceptId;
  return base.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || conceptId;
}

/** A non-empty string field, or a fallback. */
export function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}
