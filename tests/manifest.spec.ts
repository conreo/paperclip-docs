/**
 * The manifest is the host's contract, and three of its properties are load
 * bearing:
 *
 *   - the capability strings must be the host's own vocabulary, because a typo
 *     is a manifest the host rejects at install time with a message that names
 *     the capability but not the intent;
 *   - the settings slot requires `instance.settings.register`, and the host
 *     validates that pairing;
 *   - the four tools must be declared statically, because Paperclip reads them
 *     at load time, before the corpus exists.
 *
 * They are asserted rather than eyeballed because a wrong string is invisible in
 * review and fatal at runtime.
 */

import { describe, expect, it } from "vitest";

import manifest from "../src/manifest.js";
import { DOC_TOOLS, PLUGIN_ID, PLUGIN_VERSION } from "../src/constants.js";

describe("manifest", () => {
  it("identifies the plugin and its API version", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.id).toBe("paperclip-docs");
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(manifest.version).toBe("0.1.0");
  });

  it("points the host at the built worker and UI bundles", () => {
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
    expect(manifest.entrypoints.ui).toBe("./dist/ui");
  });

  it("declares exactly the capabilities the plugin uses", () => {
    expect([...manifest.capabilities].sort()).toEqual([
      "agent.tools.register",
      "instance.settings.register",
    ]);
  });

  it("does not claim a capability it has no use for", () => {
    // Least privilege: no sidebar, no page route, no local-folder access, no
    // state. A capability wider than the feature is a permission an operator
    // grants for nothing.
    for (const unwanted of [
      "ui.sidebar.register",
      "ui.page.register",
      "local.folders",
      "plugin.state.write",
      "companies.read",
    ]) {
      expect(manifest.capabilities).not.toContain(unwanted);
    }
  });

  it("takes the settingsPage slot and nothing else", () => {
    expect(manifest.ui?.slots).toHaveLength(1);
    expect(manifest.ui?.slots?.[0]).toMatchObject({
      type: "settingsPage",
      id: "docs-settings",
      exportName: "SettingsPage",
    });
  });

  it("declares all four tools with closed parameter schemas", () => {
    expect(manifest.tools?.map((tool) => tool.name)).toEqual([...DOC_TOOLS]);
    for (const tool of manifest.tools ?? []) {
      const schema = tool.parametersSchema as Record<string, unknown>;
      expect(schema["type"]).toBe("object");
      expect(schema["additionalProperties"]).toBe(false);
    }
  });

  it("declares the search parameters an agent needs", () => {
    const search = manifest.tools?.find((tool) => tool.name === "search_docs");
    const schema = search?.parametersSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "bundle",
      "limit",
      "query",
      "type",
    ]);
    expect(schema.required).toEqual(["query"]);
  });

  it("ships a closed instance config schema", () => {
    const schema = manifest.instanceConfigSchema as Record<string, unknown>;
    expect(schema["additionalProperties"]).toBe(false);
    expect(Object.keys(schema["properties"] as Record<string, unknown>).sort()).toEqual([
      "allowedBundles",
      "corpusRoot",
      "enabled",
      "maxDocChars",
      "maxResults",
    ]);
  });
});
