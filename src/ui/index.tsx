/**
 * The plugin's UI entrypoint.
 *
 * This file is the bundle's contract surface: the host resolves each declared
 * `exportName` from here. The page itself lives in a sibling module so the parts
 * worth reasoning about are ordinary functions in ordinary files rather than
 * closures inside a component.
 *
 *   SettingsPage → Settings → Plugins → Docs
 *
 * There is deliberately no sidebar slot and no page route. The reference
 * CodeGraph plugin shipped a hand-built reader for several releases and removed
 * it: the tools are the product, and a second renderer of the same markdown could
 * only fall behind the first.
 */

export { SettingsPage } from "./admin.js";
