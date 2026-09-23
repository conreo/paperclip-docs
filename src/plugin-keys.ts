/**
 * Every bridge key the plugin uses, in one place.
 *
 * ## Why this file exists
 *
 * The reference CodeGraph plugin shipped a settings page that called `index-now`
 * for four releases after an unrelated refactor deleted the worker handler. The
 * bridge answered the missing key with an error object, the page rendered it as
 * `[object Object]`, and nothing failed loudly because **no test compared the two
 * sides** — the keys were string literals scattered across the worker and the UI.
 *
 * Declaring them here makes the contract checkable, and `tests/bridge-keys.spec.ts`
 * checks it in both directions: every key the UI calls is registered by the
 * worker, and every registered key is one the UI calls (or is documented below as
 * having no UI caller). Using the constants at both ends is what keeps this
 * honest — a bare literal in the worker would quietly escape the check.
 */

/** Data handlers (`ctx.data.register` / `usePluginData`). */
export const DATA_KEYS = {
  /**
   * Corpus status for the settings page: root, bundle inventory, concept count
   * and corpus age. Read-only; it never mutates the corpus.
   */
  corpusStatus: "corpus-status",
} as const;

/**
 * Actions (`ctx.actions.register` / `usePluginAction`).
 *
 * One, and it does not write the corpus. The plugin cannot fetch anything — the
 * runtime gives it no way to spawn a process — so a refresh is a *request* written
 * into a declared local folder, for a runner on the host to honour. That is why
 * this is an operator action rather than something an agent can reach: the corpus
 * is a trust input, and whoever can write it decides what every other agent
 * believes.
 */
export const ACTION_KEYS = {
  /**
   * Write a refresh request for this company. Returns the outcome, including the
   * reason nothing was written — "refresh is off" and "already fresh" are
   * different states an operator chasing a missing rebuild needs to tell apart.
   */
  requestRefresh: "request-refresh",

  /**
   * Call the embedding endpoint with a throwaway string, before an operator turns
   * semantic retrieval on.
   *
   * Without this the only way to find out that an endpoint is unreachable, that
   * the key is wrong, or that the model name does not match the index was to
   * switch RAG on and read a search result that had quietly stayed keyword-only.
   * The endpoint is called *through the worker* rather than from the browser,
   * because the host's egress client is what the query path uses — a check from
   * the page would prove a different thing.
   */
  validateRag: "validate-rag",
} as const;

/**
 * Keys the worker registers that no UI surface calls.
 *
 * Empty for the same reason `ACTION_KEYS` is: a key registered and never called
 * is a promise nothing keeps. Listed explicitly (rather than omitted) so the
 * shape matches the reference plugin's contract test.
 */
export const KEYS_WITHOUT_UI_CALLER: readonly string[] = [];

export const ALL_DATA_KEYS: readonly string[] = Object.values(DATA_KEYS);
export const ALL_ACTION_KEYS: readonly string[] = Object.values(ACTION_KEYS);
