/**
 * Plugin-wide constants.
 *
 * Tool names are the plugin's own: there is no upstream server whose vocabulary
 * we are matching, so they are chosen to read the same way an agent already
 * reasons about documentation — `search_docs`, `read_doc`, `list_docs`,
 * `sources`. Paperclip namespaces plugin tools as `<pluginId>:<toolName>`, so
 * these are exposed to agents as e.g. `paperclip-docs:search_docs`.
 */

/** Manifest id and the namespace Paperclip prefixes onto every tool name. */
export const PLUGIN_ID = "paperclip-docs";

/** Manifest version; keep in sync with package.json. */
export const PLUGIN_VERSION = "0.3.2";

/**
 * An example corpus location, for documentation and the form's placeholder.
 *
 * It is deliberately **not** a default. A default would be one directory shared by
 * every organization, which is how a multi-tenant instance ends up serving one
 * organization another's documents: an organization whose configuration nobody had
 * touched inherited the same root and could read everything in it. The corpus root is
 * now empty until someone sets it for that organization.
 */
export const EXAMPLE_CORPUS_ROOT = "~/offline-docs/okf-bundles";

/** Tool `limit` when the caller does not pass one. */
export const DEFAULT_SEARCH_LIMIT = 5;

/** `maxResults` when the operator has not said otherwise; also the tool hard cap. */
export const DEFAULT_MAX_RESULTS = 10;

/**
 * `maxDocChars` when the operator has not said otherwise.
 *
 * 40,000 characters is roughly 10k tokens: large enough for a real reference
 * page, small enough that a single `read_doc` cannot evict a conversation.
 */
export const DEFAULT_MAX_DOC_CHARS = 40_000;

/** Bounds for the operator-tunable numbers, so a typo cannot ask for a 4 GB read. */
export const MIN_MAX_RESULTS = 1;
export const MAX_MAX_RESULTS = 100;
export const MIN_MAX_DOC_CHARS = 500;
export const MAX_MAX_DOC_CHARS = 400_000;

/** The four tools, in the order an agent should reach for them. */
export const DOC_TOOLS = ["search_docs", "read_doc", "list_docs", "sources"] as const;

export type DocToolName = (typeof DOC_TOOLS)[number];

/**
 * Per-concept body text kept in the in-memory index, for scoring and snippets.
 *
 * The alternative — holding all 80 MB of body text — makes every search a scan
 * over a corpus-sized heap. Only this prefix is indexed, which bounds the
 * worker's memory while still covering the overwhelming majority of concept
 * files outright (the corpus averages well under 8 KB per file). `read_doc`
 * always reads the real file from disk, so a term that appears only past this
 * cap is still readable — it is only *ranking* that does not see it.
 */
export const MAX_INDEX_BODY_CHARS = 4_000;

/** Headings captured per concept; a runaway document must not bloat the index. */
export const MAX_INDEX_HEADINGS = 200;

/** Rows one `list_docs` response may carry before it says it truncated. */
export const MAX_LISTING_ENTRIES = 200;

/** Characters of body shown around the best match in one search result. */
export const SNIPPET_CHARS = 500;

/**
 * How stale the newest document may be before the settings page warns.
 *
 * A local corpus is a *snapshot*. Three months is long enough that an answer
 * grounded in it may describe software that has moved on, which is exactly the
 * moment an operator should be told to rebuild.
 */
export const CORPUS_AGE_WARNING_DAYS = 90;

/** The progressive-disclosure filename every OKF directory uses. */
export const INDEX_FILENAME = "index.md";

/**
 * Candidate build-manifest filenames, checked in order.
 *
 * The Python build does not currently emit one, so `sources` reports `null`
 * rather than inventing provenance. If a future build writes one, this is where
 * it is picked up — without the plugin having to know the builder's internals.
 */
export const BUILD_MANIFEST_FILENAMES: readonly string[] = [
  "manifest.json",
  "okf-manifest.json",
  "build-manifest.json",
];

/** Caps on caller-supplied strings, so a hostile argument cannot balloon work. */
export const MAX_ARG_STRING_CHARS = 4_000;

/** Query terms considered; the rest are dropped. A 200-word "query" is not one. */
export const MAX_QUERY_TERMS = 32;

/**
 * Field weights for ranking.
 *
 * The ordering is the whole point of field weighting: a term in a title is
 * almost always more about the document than the same term buried in prose.
 * Tags are nearly as strong (an operator-curated topic), then the description
 * (written as a summary), then headings, then the body.
 */
export const FIELD_WEIGHTS = {
  title: 8,
  tags: 6,
  description: 4,
  headings: 3,
  body: 1,
} as const;

/**
 * Extra weight when the *whole* query appears verbatim in the title, not just
 * its individual terms. "transfer ownership" should outrank a document that
 * merely mentions both words in different sections.
 */
export const PHRASE_TITLE_BONUS = 6;

/** Marker appended to a truncated `read_doc` body, naming the real length. */
export function truncationMarker(shown: number, total: number): string {
  return `\n\n… [paperclip-docs: truncated at ${shown} of ${total} characters. Use list_docs to find a narrower concept, or read_doc on a sub-page.]`;
}

/** Reason codes for a refused path, shared by tools, tests and the UI. */
export type PathRefusalCode =
  | "empty"
  | "not_a_string"
  | "absolute_path"
  | "path_traversal"
  | "symlink_escape"
  | "invalid_path";

/** One file, replaced atomically: a runner takes the newest and needs no queue. */
export const REQUEST_FILENAME = "request.json";
/** What the runner writes back, which the settings page reports. */
export const RESPONSE_FILENAME = "response.json";

/** The request shape the runner understands; it refuses one it does not know. */
export const REFRESH_REQUEST_SCHEMA = 1;

/** `refresh.maxAgeDays`: how old the corpus may get before a rebuild is asked for. */
export const DEFAULT_REFRESH_MAX_AGE_DAYS = 30;
export const MIN_REFRESH_MAX_AGE_DAYS = 1;
export const MAX_REFRESH_MAX_AGE_DAYS = 3_650;

/** Source kinds the runner knows how to fetch. */
export const SOURCE_KINDS = ["git", "wiki", "llms", "local"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Conversions the runner knows how to apply. */
export const SOURCE_CONVERSIONS = ["auto", "rst", "mdx", "none"] as const;
export type SourceConversion = (typeof SOURCE_CONVERSIONS)[number];

/** The optional vector index: one metadata document and one flat float32 matrix. */
export const EMBEDDINGS_JSON = "embeddings.json";
export const EMBEDDINGS_BIN = "embeddings.bin";
export const EMBEDDINGS_SCHEMA = 1;

/** `rag`: off unless an operator turns it on and names an endpoint. */
export const DEFAULT_RAG_TOP_K = 20;
export const MIN_RAG_TOP_K = 1;
export const MAX_RAG_TOP_K = 200;
export const DEFAULT_RAG_WEIGHT = 0.5;
export const MIN_RAG_WEIGHT = 0;
export const MAX_RAG_WEIGHT = 1;
