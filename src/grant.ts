/**
 * The one step this plugin cannot take for itself: the tool profile grant.
 *
 * ## Why this module exists
 *
 * Paperclip denies a plugin tool until a tool profile names it, and nothing in a
 * manifest can declare that access — `PluginToolDeclaration` carries a name, a
 * display name, a description and a parameter schema, and nothing about who may
 * call it. The reference CodeGraph plugin therefore ships a "Make the tools
 * callable" action that creates the profile for itself. This plugin shipped none,
 * so its four registered tools sat behind a deny-by-default policy and were
 * refused for a week while every status line on this page stayed green: "the
 * corpus was found" and "an agent may call the tool" are different questions, and
 * only the first one had an indicator.
 *
 * Everything here is pure — the payloads sent, and the reading of the host's
 * response — so both can be tested without a browser or a running board. The page
 * performs the single credentialed fetch, exactly as the reference plugin does.
 */

import { DOC_TOOLS, PLUGIN_ID } from "./constants.js";

/** The profile this plugin owns. Named once; the page never spells it out again. */
export const DOCS_PROFILE_KEY = "docs-read";

/** Shown in Paperclip's own Profiles list, so it has to read like the others. */
export const DOCS_PROFILE_NAME = "Docs (read-only)";

export const DOCS_PROFILE_DESCRIPTION =
  "Read-only documentation tools: search, read, browse and report the age of this organization's corpus. Every tool is query-only.";

/**
 * Company scope, priority 100 — the same shape CodeGraph uses, and for the same
 * reason: Paperclip keeps only the narrowest matching binding tier, so binding
 * this profile to an agent would silently drop it for that agent.
 */
export const DOCS_BINDING_PRIORITY = 100;

/** The four tool names as Paperclip sees them: namespaced by plugin id. */
export function namespacedDocTools(): string[] {
  return DOC_TOOLS.map((tool) => `${PLUGIN_ID}:${tool}`);
}

/**
 * The body for `POST /api/companies/:companyId/tools/profiles`.
 *
 * `defaultAction: "deny"` is deliberate and matches the reference plugin: the
 * profile grants four named tools, and anything a future release registers is not
 * callable until an operator says so.
 */
export function buildProfileCreateBody(): Record<string, unknown> {
  return {
    profileKey: DOCS_PROFILE_KEY,
    name: DOCS_PROFILE_NAME,
    description: DOCS_PROFILE_DESCRIPTION,
    status: "active",
    defaultAction: "deny",
    entries: namespacedDocTools().map((toolName) => ({
      selectorType: "tool_name",
      effect: "include",
      toolName,
    })),
  };
}

/** The body for `POST .../tools/profiles/:profileId/bind`. */
export function buildCompanyBindingBody(companyId: string): Record<string, unknown> {
  return { targetType: "company", targetId: companyId, priority: DOCS_BINDING_PRIORITY };
}

/** One entry, for `POST /api/tool-profiles/:profileId/entries`. */
export function buildProfileEntryBody(toolName: string): Record<string, unknown> {
  return { selectorType: "tool_name", effect: "include", toolName };
}

/** What the status line needs to know, and nothing else. */
export interface GrantState {
  /** The profile's id when this plugin's profile exists, otherwise null. */
  profileId: string | null;
  /** Namespaced tools an entry includes. */
  granted: string[];
  /** Namespaced tools no entry includes. */
  missing: string[];
  /** True only when the profile exists and every tool is granted. */
  complete: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `profiles` array out of `GET /api/companies/:companyId/tools/profiles`. */
export function profilesFrom(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload)) return [];
  const profiles = payload["profiles"];
  return Array.isArray(profiles) ? profiles.filter(isRecord) : [];
}

/** The id of a profile by key, or null. Used to reuse a profile that exists. */
export function findProfileId(payload: unknown, profileKey: string = DOCS_PROFILE_KEY): string | null {
  for (const profile of profilesFrom(payload)) {
    if (profile["profileKey"] !== profileKey) continue;
    const id = profile["id"];
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/**
 * Read the grant out of the host's own answer.
 *
 * An `exclude` entry takes a tool back, so the effect is honoured rather than the
 * mere presence of a name — the same reading the gateway performs. Anything that
 * is not a `tool_name` selector (a `risk_level` entry, say) is ignored: the
 * question here is whether *these four names* are included, not whether some
 * other rule might happen to cover them.
 */
export function summarizeGrant(payload: unknown): GrantState {
  const wanted = namespacedDocTools();
  const profiles = profilesFrom(payload);
  const profile = profiles.find((candidate) => candidate["profileKey"] === DOCS_PROFILE_KEY) ?? null;

  const included = new Set<string>();
  const entries = profile?.["entries"];
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (entry["selectorType"] !== "tool_name") continue;
      const toolName = entry["toolName"];
      if (typeof toolName !== "string" || toolName.length === 0) continue;
      if (entry["effect"] === "exclude") included.delete(toolName);
      else included.add(toolName);
    }
  }

  const granted = wanted.filter((tool) => included.has(tool));
  const missing = wanted.filter((tool) => !included.has(tool));
  const id = profile?.["id"];
  const profileId = typeof id === "string" && id.length > 0 ? id : null;

  return { profileId, granted, missing, complete: profileId !== null && missing.length === 0 };
}

/**
 * Whether an error means "this already exists", which is a success for an
 * idempotent action: the host refuses a duplicate profile key or binding with a
 * message rather than a status code the caller can branch on.
 */
export function isAlreadyExistsMessage(text: string): boolean {
  return /already exists|already bound|duplicate|unique constraint/i.test(text);
}

/** The company-scoped profile collection on the host's own API. */
export function profilesPath(companyId: string): string {
  return `/api/companies/${encodeURIComponent(companyId)}/tools/profiles`;
}

/** One profile's entries, which is how a partial grant is repaired. */
export function profileEntriesPath(profileId: string): string {
  return `/api/tool-profiles/${encodeURIComponent(profileId)}/entries`;
}
