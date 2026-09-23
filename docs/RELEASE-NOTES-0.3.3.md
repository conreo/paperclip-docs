# paperclip-docs 0.3.3

Rebuilding the index no longer means re-downloading the documentation, and a corpus
rebuild no longer throws the index away.

## The index is rebuildable on its own

The runner and the plugin now speak a request that says which half of the pipeline to
run — `okf`, `index`, or `both` — and carries the embedding settings when it wants
vectors. `index` reads the corpus that is already on disk: no sources, no fetch, no
registry. That matters after a model change, and it matters when the corpus directory
is replaced, because until now the index lived *inside* it and a rebuild deleted it.

Settings → Plugins → Docs → RAG gains **Rebuild index**. It writes the request; the
runner does the work; the toast reports what the runner said rather than assuming.

## A rebuild keeps its index

A request that carries an embed block and names no mode means `both`: the corpus and
its index are built in one pass, into staging, and promoted together. So refreshing the
documentation on an organization with semantic retrieval switched on no longer leaves
it with a corpus and no vectors.

## Progress that survives being killed

The builder writes a journal beside the matrix as it embeds — the same one the settings
page reads for its progress bar — so a build that is killed resumes where it stopped
instead of starting the thirteen thousand embeddings again. `--index-only` is the mode
that exposes it; a full build keeps using it too.

Nothing else changed: the same four tools, the same closed config schema, the same
deny-by-default posture.
