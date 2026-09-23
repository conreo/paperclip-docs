# paperclip-docs 0.1.0

Initial release. Paperclip agents get governed, read-only access to a locally-installed offline
documentation corpus.

## What it is

A **serving** plugin for OKF documentation bundles. The corpus is built out of band — scraping,
cleaning, and conversion are Python's job — and this plugin indexes the resulting artifact lazily
and answers questions about it. It never writes to the corpus and persists no state.

Installing it changes nothing on its own: `enabled` defaults to `false`, and every tool call is
refused until an operator switches it on.

## Tools

All four are namespaced by the host as `paperclip-docs:<name>`.

| Tool | Purpose |
|---|---|
| `search_docs { query, bundle?, type?, limit? }` | Field-weighted ranked search. Title > tags > description > headings > body. All terms required, with a stated fallback to any-term when nothing matches all of them. |
| `read_doc { concept_id }` | Frontmatter plus the full body, truncated at `maxDocChars` with an explicit marker in the text. |
| `list_docs { bundle?, path? }` | Progressive disclosure: a directory's `index.md` when it has one, otherwise a synthesised listing of child directories and pages. |
| `sources` | Corpus root, bundle inventory with concept counts, total, oldest and newest capture timestamps, age in days, and any build manifest. |

## Configuration

Five per-company keys, closed schema, safe defaults:

| Key | Default |
|---|---|
| `enabled` | `false` |
| `corpusRoot` | `~/offline-docs/okf-bundles` |
| `allowedBundles` | `[]` (every bundle) |
| `maxResults` | `10` |
| `maxDocChars` | `40000` |

An unknown key is rejected **by name**, not silently dropped. A setting that was quietly ignored is
one an operator believes took effect.

## Settings page

**Settings → Plugins → Docs.** A **Status** section (tool state, corpus location, concept and
bundle counts, oldest/newest capture timestamp, and a warning past 90 days) and a **Configuration**
section that saves immediately — no Save button for either the switch or the text fields.

## Security

- Paths from `read_doc` and `list_docs` are resolved against the corpus root and refused if they
  escape it: absolute paths, `..` segments, and symlinks — including one in an ancestor directory —
  are all rejected, and a refusal is a named result rather than a thrown error.
- The bundle allowlist can narrow visibility to a subset of top-level bundles.
- Result size is bounded in both directions: `maxResults` for search, `maxDocChars` for a document.
- The index is built once, lazily, and invalidated on a cheap mtime signature of the corpus; a
  search does not re-read the corpus from disk.
- The plugin declares only `agent.tools.register` and `instance.settings.register`. No writes, no
  state, no local-folder access.

## Compatibility

- `apiVersion: 1`; Peer `@paperclipai/plugin-sdk` ≥ 2026.817.0 and React ≥ 18.
- Node.js ≥ 20.
- Slot: `settingsPage` only. No sidebar entry, no page route.

## Known limitations

- Ranking indexes only a bounded body prefix per concept (`MAX_INDEX_BODY_CHARS`, currently 4,000
  characters), so a term that appears only deep in a very long page is *readable* but does not
  *rank* that page. `read_doc` always reads the real file in full (up to the cap).
- Invalidation notices a rebuilt corpus (directory mtimes), not a single file edited in place by
  hand. Editing a build artifact directly is not a supported workflow.
- The corpus has no updater. Keeping it current means re-running the Python build; `sources` and the
  status page exist so an agent or operator can see when that is overdue.
