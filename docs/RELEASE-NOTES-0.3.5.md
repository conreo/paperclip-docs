# paperclip-docs 0.3.5

The tools stop telling agents where the corpus is.

## `sources` no longer reports the corpus root

Its first line was `Corpus root: /paperclip/offline-docs/okf-bundles`, and its payload
carried the root and the manifest path. Both are host paths — and that directory holds
the vector index, the runner's `request.json` (which names the embedding endpoint) and
the scripts that start it.

The consequence was not theoretical: an agent with a shell read that path, found the
server scripts, and **did the retrieval by hand** — embedding the query itself and
cosine-ranking it against `embeddings.bin` — because it could see where the machinery
was and could not call `search_docs`. An agent needs the snapshot's age and what is in
it. It does not need the deployment's paths, and telling it where things are is an
invitation to work around the tool that exists to do this properly.

The same change drops the root and manifest path from the payload of a corpus that
could not be read, which is exactly the moment an agent goes looking for itself.

The settings page keeps them: it has its own data handler, and an operator configuring
a corpus directory does need to know where it is.

## The endpoint field says what the worker will refuse

Paperclip's outbound fetch refuses private IPv4 — `10/8`, `172.16/12`, `192.168/16`,
`127/8`, link-local — and allows the tailnet range `100.64/10`. An embedding server on
the LAN therefore cannot be called from the worker, and configuring one left semantic
retrieval falling back to keyword search *while looking configured*. The field now says
so, and points at **Validate endpoint**, which makes the call through the worker and is
the only check that proves an address actually works from where it is used.

Nothing else changed: the same four tools, the same closed config schema, the same
deny-by-default posture.
