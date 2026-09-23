# paperclip-docs

**Your agents stop guessing about the stack.** Give Paperclip a local copy of the
documentation for the tools and libraries it works with, and agents can search and read it
through governed tools instead of recalling it from training data, fetching it from the web,
or inventing it.

`paperclip-docs` is a [Paperclip](https://github.com/paperclipai/paperclip) plugin. It indexes a
locally installed documentation corpus and exposes it through four agent tools. Every call flows
through Paperclip's own tool gateway, so what an agent may read is governed exactly like any other
plugin tool — and the plugin is read-only: it never writes to your corpus and stores nothing.

```
paperclip-docs:search_docs   ranked full-text search across the corpus
paperclip-docs:read_doc      one page in full, capped and truncation-marked
paperclip-docs:list_docs     progressive disclosure over the directory tree
paperclip-docs:sources       what is installed, and how old it is
```

---

## What you need first: a corpus

**This plugin serves a corpus; it does not build one.** There is no scraper and no ingest step
here, and that is deliberate — fetching vendor documentation is a batch job with its own
dependencies and hours-long runtime, and an agent must never be able to trigger a re-scrape by
calling a tool.

A corpus is just a directory of markdown files with YAML frontmatter:

```
docs-corpus/
├── index.md                  # optional root index
├── postgresql/
│   ├── index.md              # optional per-directory index
│   ├── backup.md
│   └── replication.md
└── traefik/
    └── routing.md
```

Each page is markdown with a frontmatter block:

```markdown
---
type: Guide
title: "Point-in-time recovery"
description: "Restoring to a chosen recovery target"
resource: https://www.postgresql.org/docs/current/continuous-archiving.html
tags: [postgresql, backup]
timestamp: 2026-07-03T02:22:34Z
---

WAL archiving lets you restore to any point in time…
```

The top-level directories are **bundles** — the unit you allow or deny per organization. Nothing
else is required: a directory of hand-written notes works, and it is a perfectly good way to start.
If you want a large vendor corpus, you build it yourself, out of band, with whatever tooling you
like; the plugin will index it as long as the shape above holds.

### How old is the corpus?

`timestamp` is what makes answers honest. `sources` reports the oldest and newest capture dates and
the age in days, and the settings page warns once the newest capture is more than 90 days old — so
an agent can say *"the docs I have are from July"* instead of presenting six-month-old vendor
documentation as current. **Refresh is your job**: replacing the directory is the entire update
mechanism, and the plugin picks it up on the next call.

## Install

```bash
paperclipai plugin install paperclip-docs
```

Or install it from the Plugin Manager in **Settings → Plugins**. Then open
**Settings → Plugins → Docs**.

### Installing does not put anything in front of an agent

Two gates, deliberately:

1. **It installs off.** `enabled` defaults to `false`; while off, every call is refused.
2. **Then you grant the tools.** Plugin tools are deny-by-default, so an agent sees them only once
   its tool profile allows them. Until then the plugin is running and answering nothing.

**No MCP client is needed.** Unlike a code-intelligence plugin, these tools are delivered through
Paperclip's tool gateway — you do not add anything to an agent's adapter, and there is no
`mcp.json` to write. If an agent cannot see the tools, the answer is a profile grant, never a
missing MCP config.

### Set the corpus path

`corpusRoot` defaults to `~/offline-docs/okf-bundles`, where `~` is the **worker process's** home
directory — not yours, and in a container not the host's. If the settings page says the corpus was
not found, that path is almost always why. Point it at the absolute path inside the environment
where Paperclip runs.

## Configuration

All five keys are per-company, closed (`additionalProperties: false`), and visible on the settings
page. An unknown key is **rejected with its name in the error**, never silently dropped — a
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

Tokenises the query and scores every page by **where** each term matches:

```
title (8) > tags (6) > description (4) > headings (3) > body (1)
```

plus a bonus when the whole query appears verbatim in the title. All terms must match (**AND**); if
nothing matches all of them, the search retries with any term (**OR**) and states which mode
produced the result, so an exact answer is distinguishable from a loose one.

Returns, per hit: `bundle`, `concept_id`, `title`, `type`, `heading`, a ~500-character `snippet`,
`resource`, `timestamp`, and `score`. `limit` defaults to 5 and is clamped to `maxResults`.

Pass `bundle` whenever you know which product you mean. With several unrelated products in one
corpus, an unfiltered query is the main way to get a plausible answer from the wrong one — and the
`concept_id` in every hit tells the agent where it came from.

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
returned — the natural table of contents for that level. Otherwise the plugin synthesises a listing
of child directories (with page counts) and child pages (with descriptions). With no arguments it
lists the bundles. `path` may be given without `bundle`, in which case its first segment is the
bundle.

### `sources`

No parameters. Returns the corpus root, each visible bundle with its page count, the total, the
**oldest and newest `timestamp`** in frontmatter, the age in days, and any build manifest
(`manifest.json`, `okf-manifest.json`, or `build-manifest.json`) if your builder writes one.

## Multiple organizations

Corpora are usually shared — the same public documentation is useful to everyone — so there is
nothing to bind per organization. What differs is **which bundles** each organization may read, and
`allowedBundles` is the only content control, which is why it holds on every path:

- search results are filtered, so an ungranted bundle is not discoverable;
- listings are filtered, so it is not browsable;
- **reads are filtered too** — naming a page in an ungranted bundle is refused, because a path that
  reaches a file is a boundary you cannot enforce by hiding it.

The **settings page deliberately shows every bundle**, including ones this organization has not
been granted: an operator configuring the allowlist has to see what is available to grant. Agents
see only what they may read.

Two organizations can also point at different corpora; the plugin keys its index by root, so
neither can be answered from the other's.

## Security

The corpus is a directory tree on the server, and `read_doc` / `list_docs` accept a path from an
agent. That makes an unvalidated path a filesystem read primitive dressed up as a documentation
lookup. Every path passes through one deny-by-default resolver:

- **Absolute paths are refused**, in POSIX, drive-letter, and UNC forms.
- **`..` segments are refused** before any join, so no normalisation can argue the result is inside
  the root. A filename that merely contains dots (`v1..2.md`) is fine.
- **Symlinks are resolved and the *real* path is re-checked** — including a symlink in an ancestor
  directory, which is why the nearest existing ancestor is resolved, not only the leaf. A symlink
  inside the corpus that points outward is refused at read time and skipped while indexing.
- A refused path is a **named result, not a throw**: the tool returns a sentence, never a stack
  trace.

Other bounds:

- **Result caps.** `maxResults` bounds search output; `maxDocChars` bounds a document. Both have
  schema minimums and maximums, so a typo cannot ask for a 4 GB read.
- **Allowlist entries are plain bundle names**, not paths (`n8n/../grafana` is rejected).
- **Lazy, mtime-invalidated index.** The corpus is walked once and cached against a cheap mtime
  signature. A search does not re-read the corpus from disk per request.
- **No writes to the corpus, no state, and no egress unless you ask for it.** The plugin persists
  nothing of its own, and it never modifies the corpus. Its capabilities are exactly four, and each
  is used:

  | Capability | Why |
  |---|---|
  | `agent.tools.register` | the four tools |
  | `instance.settings.register` | the settings page |
  | `http.outbound` | only the optional semantic path, and only when it is switched on |
  | `secrets.read-ref` | resolving an embedding key by reference, so the value stays in the host |

  Inspect that list before trusting the plugin — it is short on purpose, and a test asserts each one
  is used rather than declared and forgotten.

### A note on the documentation itself

The plugin ships **no corpus** — that is partly a licensing decision. Vendor documentation carries
its own terms, and redistributing a corpus is between you and the vendor. Keeping ingestion out of
the package keeps that your call.

## Settings page

**Settings → Plugins → Docs** has two sections:

- **Status** — whether the tools are on, whether the corpus was found and where, page and bundle
  counts, the oldest/newest capture timestamp, and a warning when the newest capture is more than
  90 days old.
- **Configuration** — the switch and the four fields, **saving immediately**. There is no Save
  button: a form that needs saving is one that can be abandoned half-changed. Text fields commit on
  blur or Enter, and failures surface through the host toast with thrown objects normalised, so the
  page never shows `[object Object]`.

## If nothing works

| Symptom | Cause |
|---|---|
| Settings page: *corpus not found* | `corpusRoot` resolves inside the **worker's** environment. Check the path there, not on your machine. |
| Tools never appear for an agent | They are deny-by-default. Grant them in the agent's tool profile — and check the plugin is enabled for that company first. |
| Search returns nothing useful | Pass `bundle`. With several products in one corpus, an unfiltered query is how you get the wrong product's answer. |
| `sources` warns the corpus is stale | Nothing is broken; the snapshot is old. Refresh the directory. |
| A page is missing from results | Pages whose frontmatter does not parse, or with no `type`, are skipped or degraded rather than failing the search. Check the file's frontmatter. |

## Telling it what to build

The plugin **cannot fetch anything**. That is not a limitation it works around: the plugin runtime
offers no way to spawn a process, so there is no `git`, no `pandoc` and no way to rebuild a corpus
from inside a worker. What it can do is say what it needs.

So the corpus is built by a **runner on your host** — `fetch.py` and `runner.py` from
[paperclip-docs-builder](https://github.com/conreo/paperclip-docs-builder) — and this plugin holds
two things about it: a registry of what you want, and the request that asks for it.

```jsonc
"sources": [                                // the registry, per organization
  { "id": "nextcloud", "kind": "git", "repo": "https://github.com/nextcloud/documentation",
    "ref": "stable30", "include": ["**/*.md"] },
  { "id": "handbook", "kind": "local", "folder": "/srv/handbook" }   // your own docs, as a bundle
],
"refresh": { "enabled": true, "maxAgeDays": 30 }
```

With `refresh.enabled`, the settings page offers **Request a rebuild now**. It writes `request.json`
into `<corpusRoot>.requests` — a sibling of the corpus, derived from it, so **there is no path to
configure anywhere**. The runner derives the same directory, and writes `response.json` beside the
request, which this page reads back: you see what the last build actually did without opening a
container log.

Nothing about the deployment appears in this plugin's settings. The corpus root, the source registry
and the request location are set by whoever deploys it — you, or an agent working through Paperclip's
config API. The page opens on the two things an operator comes for: is it working, and who may read
it. Staleness is measured
from the build manifest's date, never from file mtimes: a restore from backup makes every file look
new, and the corpus would then never be rebuilt.

Agents cannot trigger any of this. The corpus is a trust input — whoever can write it decides what
every other agent believes — so a refresh is an operator action, and the build is a script with
pinned versions rather than an agent run with a token.

## Semantic retrieval (optional)

Keyword search is the baseline and needs no configuration. If you want ranking by meaning as well —
which is what finds a page that says *"single sign-on"* for the query *SSO* — enable it and point it
at an OpenAI-compatible embeddings endpoint:

```jsonc
"rag": { "enabled": true, "endpoint": "https://api.example.com/v1/embeddings",
         "model": "bge-small", "secretRef": "…", "weight": 0.5 }
```

The corpus needs an index for this, which the builder writes (`embeddings.json` plus a flat float32
matrix) when you give it the same endpoint. The plugin reads those files and does the arithmetic
itself; there is no vector database, because a worker that cannot spawn a process cannot host one.

It is designed to fail softly and say so: no index, a different model, an endpoint that is down, an
index that covers only some bundles — each of those returns keyword results plus a sentence
explaining what did not happen. An operator who switched this on deserves to know when they did not
get it.

## How this differs from the bundled LLM Wiki plugin

Both deal with local documentation, in opposite directions, and they compose well:

| | **LLM Wiki** (`@paperclipai/plugin-llm-wiki`) | **paperclip-docs** (this plugin) |
|---|---|---|
| Direction | **builds and maintains** a wiki | **serves** a corpus you already have |
| Writes | writes pages, manages sources, migrations, a DB namespace | read-only, stateless, no migrations |
| Uses a model | distils sources into wiki pages with an LLM | never — search and read only |
| Content | generated and continuously edited | whatever you put in the directory, at a version you chose |
| Tools | search/read/write/patch/source/log/index/backlinks | search/read/list/sources |

If you want Paperclip to *maintain* knowledge from your issues and sources, use LLM Wiki. If you
want agents to answer from a specific, versioned set of documentation and be able to say how old it
is, use this.

## Development

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run build          # esbuild worker + manifest + ui
npm test               # vitest
npm run verify         # typecheck && build && test
npm run dev            # esbuild --watch
```

Tests build their own small fixture corpora in the OS temp directory and never read a real one: a
test that depended on one machine's build artifact would pass there and fail everywhere else. There
is also a live suite that runs the tools against a real corpus when one is present
(`PAPERCLIP_DOCS_TEST_CORPUS=/path/to/corpus`), and skips otherwise.

The published package is built without sourcemaps (`npm run prepack`): nothing consumes them at
runtime and they are most of the bytes.

## Requirements

- Node.js ≥ 20, and a Paperclip instance that provides the plugin SDK.
- A corpus: a directory of markdown with OKF-style frontmatter. This plugin does not create one.

## License

MIT. See [LICENSE](LICENSE).
