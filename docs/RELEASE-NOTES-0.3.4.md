# paperclip-docs 0.3.4

The page becomes a dashboard, and a bundle can be deleted.

## Delete a bundle, without re-fetching anything

Each bundle in "Bundles agents may read" now has a **Delete** button beside its switch.
The two are deliberately different operations, and the page used to offer only the
first: switching a bundle off stops agents reading it and is reversible in one click,
while deleting removes the pages from disk.

Deletion is a `prune` request the host runner honours. It fetches nothing, and drops
exactly the index rows whose concept ids belonged to that bundle — the surviving
vectors are byte-identical, so removing one bundle cannot change what semantic search
does for the pages that stay. On a 13,000-concept corpus that is a second rather than
an embedding run. It is idempotent, so a request retried after it succeeded reports
"already absent" rather than failing.

The manifest stops claiming what was removed and records it under `pruned`, so a tree
that shrank and a manifest that disagrees with it cannot go unnoticed.

## The registry has a UI at last

`sources` has been in the schema since the first version with no control anywhere, and
the runner refuses a build request without it — so "Request a rebuild now" wrote a
request that could only be refused, and no page could fix it. **Sources to build** now
edits it as rows: bundle name, kind, repository or URL or folder, version to pin,
include and exclude globs.

Two more settings that had no control are now on the page: **scheduled rebuilds**
(`refresh.enabled`, which was permanently false) and **candidates from the index**
(`rag.topK`, previously the default and nothing else).

## Cards, and a state pill that answers the question first

OKF and RAG are now cards with a state pill — "6 of 22 bundles readable", "13,029
vectors · bge-m3" — computed from the same values the sections use, never a second
guess. The page leads with the answer instead of eighteen sections of reading.

Nothing else changed: the same four tools, the same closed config schema, the same
deny-by-default posture.
