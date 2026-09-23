import { describe, expect, it } from "vitest";

import { DOC_TOOLS, PLUGIN_ID } from "../src/constants.js";
import {
  DOCS_BINDING_PRIORITY,
  DOCS_PROFILE_KEY,
  buildCompanyBindingBody,
  buildProfileCreateBody,
  buildProfileEntryBody,
  findProfileId,
  isAlreadyExistsMessage,
  namespacedDocTools,
  profileEntriesPath,
  profilesPath,
  summarizeGrant,
} from "../src/grant.js";

const NAMESPACED = DOC_TOOLS.map((tool) => `${PLUGIN_ID}:${tool}`);

/** One include entry, as the host stores it. */
function include(toolName: string) {
  return { selectorType: "tool_name", effect: "include", toolName, conditions: null };
}

/** The shape of `GET /api/companies/:companyId/tools/profiles`. */
function profilesPayload(entries: unknown[], profileKey = DOCS_PROFILE_KEY, id = "profile-1") {
  return { profiles: [{ id, profileKey, name: "Docs (read-only)", status: "active", entries }] };
}

describe("the profile this plugin creates", () => {
  it("grants all four tools, namespaced by plugin id", () => {
    const body = buildProfileCreateBody();
    const entries = body["entries"] as Array<{ toolName: string }>;
    expect(entries.map((entry) => entry.toolName).sort()).toEqual([...NAMESPACED].sort());
    expect(namespacedDocTools()).toEqual(NAMESPACED);
  });

  it("matches every tool by exact tool_name, because globs match nothing", () => {
    const entries = buildProfileCreateBody()["entries"] as Array<Record<string, unknown>>;
    for (const entry of entries) {
      expect(entry["selectorType"]).toBe("tool_name");
      expect(entry["effect"]).toBe("include");
      expect(JSON.stringify(entry)).not.toContain("*");
      expect(entry["conditions"] ?? null).toBeNull();
    }
  });

  it("denies by default, so a tool added later is not callable by accident", () => {
    const body = buildProfileCreateBody();
    expect(body["defaultAction"]).toBe("deny");
    expect(body["status"]).toBe("active");
    expect(body["profileKey"]).toBe(DOCS_PROFILE_KEY);
  });

  it("binds at company scope, which is the tier that survives precedence", () => {
    // Paperclip keeps only the narrowest matching binding tier; an agent-scoped
    // binding would silently drop the profile for that agent.
    expect(buildCompanyBindingBody("company-1")).toEqual({
      targetType: "company",
      targetId: "company-1",
      priority: DOCS_BINDING_PRIORITY,
    });
  });

  it("repairs one missing tool with a single exact entry", () => {
    expect(buildProfileEntryBody(`${PLUGIN_ID}:list_docs`)).toEqual({
      selectorType: "tool_name",
      effect: "include",
      toolName: `${PLUGIN_ID}:list_docs`,
    });
  });

  it("puts the company id in the path, escaped", () => {
    expect(profilesPath("a b")).toBe("/api/companies/a%20b/tools/profiles");
    expect(profileEntriesPath("p/1")).toBe("/api/tool-profiles/p%2F1/entries");
  });
});

describe("reading the grant back", () => {
  it("is complete when the profile includes all four", () => {
    const state = summarizeGrant(profilesPayload(NAMESPACED.map(include)));
    expect(state.complete).toBe(true);
    expect(state.missing).toEqual([]);
    expect(state.profileId).toBe("profile-1");
  });

  it("names what is missing rather than reporting a bare failure", () => {
    const partial = [include(`${PLUGIN_ID}:search_docs`), include(`${PLUGIN_ID}:read_doc`)];
    const state = summarizeGrant(profilesPayload(partial));
    expect(state.complete).toBe(false);
    expect(state.granted).toEqual([`${PLUGIN_ID}:search_docs`, `${PLUGIN_ID}:read_doc`]);
    expect(state.missing).toEqual([`${PLUGIN_ID}:list_docs`, `${PLUGIN_ID}:sources`]);
  });

  it("treats an absent profile as nothing granted — the state that was invisible", () => {
    const state = summarizeGrant({ profiles: [] });
    expect(state.profileId).toBeNull();
    expect(state.granted).toEqual([]);
    expect(state.missing).toEqual(NAMESPACED);
    expect(state.complete).toBe(false);
  });

  it("does not mistake another plugin's profile for this one", () => {
    const state = summarizeGrant({
      profiles: [
        { id: "codegraph-1", profileKey: "codegraph-read", entries: NAMESPACED.map(include) },
      ],
    });
    expect(state.profileId).toBeNull();
    expect(state.complete).toBe(false);
  });

  it("honours an exclude that takes a tool back", () => {
    const entries = [...NAMESPACED.map(include), { selectorType: "tool_name", effect: "exclude", toolName: `${PLUGIN_ID}:sources` }];
    const state = summarizeGrant(profilesPayload(entries));
    expect(state.missing).toEqual([`${PLUGIN_ID}:sources`]);
    expect(state.complete).toBe(false);
  });

  it("ignores selectors that are not tool_name", () => {
    const state = summarizeGrant(
      profilesPayload([
        { selectorType: "risk_level", effect: "include", riskLevel: "low" },
        include(`${PLUGIN_ID}:sources`),
      ]),
    );
    expect(state.granted).toEqual([`${PLUGIN_ID}:sources`]);
    expect(state.missing).toHaveLength(3);
  });

  it("survives a payload it does not recognise", () => {
    for (const payload of [null, undefined, 42, "nope", {}, { profiles: "nope" }, { profiles: [null] }]) {
      const state = summarizeGrant(payload);
      expect(state.complete).toBe(false);
      expect(state.missing).toEqual(NAMESPACED);
    }
  });
});

describe("running it twice", () => {
  it("recognises the host's already-exists answer", () => {
    expect(isAlreadyExistsMessage("A tool profile with this key already exists")).toBe(true);
    expect(isAlreadyExistsMessage("profile is already bound to this target")).toBe(true);
    expect(isAlreadyExistsMessage("duplicate key value violates unique constraint")).toBe(true);
    expect(isAlreadyExistsMessage("Board access required")).toBe(false);
    expect(isAlreadyExistsMessage("Tool profile not found")).toBe(false);
  });

  it("reuses a profile that already exists, by key", () => {
    const payload = {
      profiles: [
        { id: "other", profileKey: "codegraph-read", entries: [] },
        { id: "docs-1", profileKey: DOCS_PROFILE_KEY, entries: [] },
      ],
    };
    expect(findProfileId(payload)).toBe("docs-1");
    expect(findProfileId({ profiles: [] })).toBeNull();
    expect(findProfileId(null)).toBeNull();
  });
});
