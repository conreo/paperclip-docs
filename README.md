# paperclip-docs

Offline documentation for Paperclip agents, served as governed, read-only tools.

`paperclip-docs` is a [Paperclip](https://github.com/paperclipai/paperclip) plugin. It indexes a
locally-installed **OKF** (Open Knowledge Format) documentation corpus and exposes it through four
agent tools. Every call flows through Paperclip's own tool gateway, so what an agent may read is
governed the same way as any other plugin tool.

```
paperclip-docs:search_docs   ranked full-text search across the corpus
paperclip-docs:read_doc      one concept in full, capped and truncation-marked
paperclip-docs:list_docs     progressive disclosure over the directory tree
paperclip-docs:sources       what is installed, and how old it is
```

Tools are namespaced by the host; agents see them as `paperclip-docs:<name>`.

---

## A serving plugin, not a building one

The corpus is built **out of band, in Python**. Scraping vendor documentation, cleaning HTML to
markdown, and converting it to OKF bundles is a batch job with its own dependencies, its own
failure modes, and a runtime measured in hours. None of that belongs in a worker process, and an
agent must not be able to trigger a re-scrape by calling a tool.

So the split is deliberate:

| | |
|---|---|
| **Build** (Python, elsewhere) | fetch → clean → convert → `okf-bundles/` |
| **Serve** (this plugin) | index `okf-bundles/` lazily, answer questions about it |

This plugin never writes to the corpus. The directory is an input. Its entire job is to answer
accurately — including accurately saying *how old the snapshot is*, which is what `sources` exists
for. An agent that answers from a two-year-old snapshot without saying so is worse than one that
answers "the docs I have are from 2024".

## The corpus format

```
okf-bundles/
├── index.md                 # optional root index
├── n8n/
│   ├── index.md             # progressive disclosure, one per directory
│   └── integrations/…/foo.md
└── grafana/…
```

Every concept is a markdown file with YAML frontmatter:

```markdown
---

type: Guide
title: "Transfer Ownership"
description: "- Files & synchronization"
resource: https://docs.nextcloud.com/…
tags: [nextcloud]
timestamp: 2026-07-03T02:22:34Z
okf_version: "0.1"

---

<body>
```

Top-level directories are **bundles**. The plugin tolerates what the real corpus actually contains:
a leading blank line before the frontmatter, `CRLF` endings, `index.md` files with no fields but
`okf_version`, files with no frontmatter at all, `Untitled` titles, and frontmatter that does not
parse. A bad concept is skipped or degraded; it never fails a search.

## Install

```bash
npm install
npm run build          # dist/worker.js, dist/manifest.js, dist/ui/
```

Install the package into Paperclip as a local-path plugin, then open
**Settings → Plugins → Docs** and switch it on. It is **off by default**: installing a plugin must
not, by itself, put a corpus in front of an agent.

## Configuration

All five keys are per-company, closed (`additionalProperties: false`), and observable from the
settings page. An unknown key is **rejected with its name in the error**, not silently dropped — a
silently-dropped setting is one an operator believes took effect.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | While off, every tool call is refused. |
| `corpusRoot` | string | `~/offline-docs/okf-bundles` | The bundle directory to serve. `~` expands to the worker user's home. Absolute only. |
| `allowedBundles` | string[] | `[]` | Allowlist of bundle names. `[]` means every bundle. |
| `maxResults` | number | `10` | Hard ceiling on `search_docs` results, whatever an agent asks for. 1–100. |
| `maxDocChars` | number | `40000` | Character cap for one `read_doc` body. 500–400000. |

## Tools

### `search_docs { query, bundle?, type?, limit? }`

Tokenises the query and scores every concept by **where** each term matches:

```
title (8) > tags (6) > description (4) > headings (3) > body (1)
```

plus a bonus when the whole query appears verbatim in the title. All terms must match (**AND**); if
nothing matches all of them, the search retries with any term (**OR**) and the result states which
mode produced it, so an exact answer is distinguishable from a loose one.

Returns, per hit: `bundle`, `concept_id`, `title`, `type`, `heading`, a ~500-character `snippet`,
`resource`, `timestamp`, and `score`. `limit` defaults to 5 and is clamped to the configured
`maxResults`.

### `read_doc { concept_id }`

Returns frontmatter metadata plus the full markdown body, **truncated at `maxDocChars` with an
explicit marker**:

```
… [paperclip-docs: truncated at 40000 of 61234 characters. Use list_docs to find a narrower
concept, or read_doc on a sub-page.]
```

The cap and the marker are the point. An unbounded tool result does not fail; it silently evicts
whatever the agent was holding, and a *quiet* cut is worse than a stated one because the model
cannot tell it is missing anything.

### `list_docs { bundle?, path? }`

Progressive disclosure, one level at a time. If the requested directory has an `index.md`, that is
returned — the builder wrote it as the level's table of contents. Otherwise the plugin synthesises
a listing of child directories (with concept counts) and child pages (with descriptions). With no
arguments it lists the bundles. `path` may be given without `bundle`, in which case its first
segment is the bundle.

### `sources`

No parameters. Returns the corpus root, each bundle with its concept count, the total, the
**oldest and newest `timestamp`** in frontmatter, the age in days, and any build manifest
(`manifest.json`, `okf-manifest.json`, or `build-manifest.json`) if the builder wrote one.

A snapshot must be able to state its own age. Without this, an agent answers from documentation
that may describe a version nobody runs any more, and the answer reads exactly like a current one.

## Security notes

The corpus is a directory tree on the server, and `read_doc` / `list_docs` accept a path from an
agent. That makes an unvalidated path a filesystem read primitive dressed up as a documentation
lookup. Every path passes through one deny-by-default resolver:

- **Absolute paths are refused**, in POSIX, drive-letter, and UNC forms.
- **`..` segments are refused** before any join, so no normalisation can argue the result is
  inside the root. A filename that merely contains dots (`v1..2.md`) is fine.
- **Symlinks are resolved and the *real* path is re-checked** — including a symlink in an ancestor
  directory, which is why the nearest existing ancestor is resolved, not only the leaf. A symlink
  inside the corpus that points outward is refused at read time and skipped during indexing.
- A refused path is a **named result, not a throw**: the tool returns a sentence, never a stack
  trace.

Other bounds:

- **Result caps.** `maxResults` bounds search output; `maxDocChars` bounds a document. Both are
  operator-set and both have schema minimums and maximums, so a typo cannot ask for a 4 GB read.
- **Bundle allowlist.** `allowedBundles` narrows which top-level bundles are visible; an allowlist
  entry must be a plain bundle name, not a path (`n8n/../grafana` is rejected).
- **Lazy, mtime-invalidated index.** The corpus is walked once and cached; the cache is keyed on a
  cheap mtime signature of the root and bundle directories. A search does not read 80 MB from disk
  per request, and an edit to a build artifact is not something the plugin pretends to track.
- **No writes, no state.** The plugin persists nothing and declares no state or local-folder
  capability. Its only capabilities are `agent.tools.register` and `instance.settings.register`.

## Settings page

**Settings → Plugins → Docs** has two sections:

- **Status** — whether the tools are on, whether the corpus was found and where, the concept and
  bundle counts, the oldest/newest capture timestamp, and a warning banner when the newest capture
  is more than 90 days old.
- **Configuration** — the switch and the four fields, **saving immediately**. There is no Save
  button anywhere on the page: a form that needs saving is one that can be abandoned half-changed.
  Text fields commit on blur or Enter. Failures surface through the host toast, with thrown objects
  normalised so the page never shows `[object Object]`.

## Development

```bash
npm run typecheck      # tsc --noEmit
npm run build          # esbuild worker + manifest + ui
npm test               # vitest
npm run verify         # typecheck && build && test
npm run dev            # esbuild --watch
```

Tests build their own small fixture corpora in the OS temp directory. They never read a real corpus:
a test that depended on one machine's build artifact would pass there and fail everywhere else.

## Requirements

- Node.js ≥ 20.
- `@paperclipai/plugin-sdk` (peer) and React ≥ 18 (peer, for the UI bundle).
- A corpus produced by an OKF build. This plugin does not create one.

## License

MIT. See [LICENSE](LICENSE).
