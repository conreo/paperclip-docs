# paperclip-docs 0.3.2

Two things this plugin always needed: a way to make its own tools callable, and a settings page
that says where the corpus is and whether ranking by meaning can actually work.

## The grant this plugin never made

A plugin tool is refused until a tool profile names it, and nothing in a manifest can declare that
access. The reference CodeGraph plugin therefore ships a "Make the tools callable" action; this one
shipped nothing — so its four tools were registered, listed, and refused, while every status line on
the settings page stayed green. "The corpus was found" and "an agent may call the tool" are
different questions, and only the first one had an answer.

**Settings → Plugins → Docs → Agent access** now answers the second, and offers one button. It
creates a company-scoped `docs-read` profile holding the four namespaced tools, binds it, and only
ever adds: an existing profile is reused, a partial grant is repaired one entry at a time, and
nothing is ever taken away. Entries are exact `tool_name` matches, because globs match nothing.

## The settings page has sections now

- **OKF** — the corpus: `enabled`, `corpusRoot`, the bundles this organization may read, the rebuild
  request, and the two result limits. `corpusRoot` was in the schema but had no field anywhere, so
  the only way to set it was the API. It has one now, with the trap spelled out: `~` is the
  *worker's* home, which inside a container is not the operator's.
- **RAG** — the optional ranking on top of keyword search: endpoint, model, key reference, weight,
  the index that is installed, and a **Validate endpoint** button. The check runs in the worker,
  through the same egress client a search uses, so a pass means what it says — and it reports a
  model that disagrees with the installed index, which is otherwise a silently wrong answer. The
  "Also rank by meaning" switch stays off until the check succeeds.

## A build you can watch

The indexer runs on the host and says nothing between "started" and "wrote embeddings.json". It is
resumable, and that means it keeps a journal beside the corpus — so the page reads that journal and
shows real progress (`7,104 of 12,770 concepts (55%)`), or reports an interrupted build when the
journal went quiet without producing an index. Two reads, no new protocol.

Nothing else changed: the same four tools, the same closed config schema, the same
deny-by-default posture.
