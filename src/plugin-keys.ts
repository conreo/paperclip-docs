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
 * There are none. This plugin serves a static artifact, so every surface is a
 * read and every write an operator needs goes through the host's own config API
 * on `/api/plugins/:pluginId/config` (the same path the reference plugin's UI
 * uses for its text fields). A registered action with no caller would be dead
 * weight the bridge-keys test would have to exempt, so the table is empty
 * rather than aspirational.
 */
export const ACTION_KEYS = {} as const;

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
