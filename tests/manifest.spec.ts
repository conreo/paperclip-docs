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
import { readFileSync } from "node:fs";

import { DOC_TOOLS, PLUGIN_ID, PLUGIN_VERSION } from "../src/constants.js";

describe("manifest", () => {
  it("identifies the plugin and its API version", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.id).toBe("paperclip-docs");
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.version).toBe(PLUGIN_VERSION);
    // Kept as a literal on purpose: it forces a version bump to be a deliberate edit
    // here as well as in package.json, and the two drifting apart is exactly what
    // this catches.
    expect(manifest.version).toBe("0.2.1");
    expect(manifest.version).toBe(
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
    );
  });

  it("points the host at the built worker and UI bundles", () => {
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
    expect(manifest.entrypoints.ui).toBe("./dist/ui");
  });

  it("declares exactly the capabilities the plugin uses", () => {
    expect([...manifest.capabilities].sort()).toEqual([
      "agent.tools.register",
      "http.outbound",
      "instance.settings.register",
      // Resolves the embedding key by reference, so the value stays in the host.
      "secrets.read-ref",
    ]);
  });

  it("asks the operator to configure no filesystem path at all", () => {
    // This test has now been through all three positions, and the history is the
    // point. It began by asserting `local.folders` was absent. When refresh
    // requests arrived it asserted the capability was *used*, with a declared folder
    // — which made Paperclip ask the operator to choose a directory, and showed the
    // plugin as "needs attention" until they did. A filesystem path is a deployment
    // detail, so the folder declaration is gone and the request location is derived
    // from the corpus root instead. What is asserted now is that nothing is left to
    // configure.
    expect(manifest.capabilities).not.toContain("local.folders");
    expect(manifest.localFolders ?? []).toHaveLength(0);
  });

  it("declares a capability only where the source uses it", () => {
    // An egress capability granted for a feature that never calls out is a
    // permission an operator gave for nothing, so each is checked against the code.
    const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(worker).toContain("ctx.http.fetch");
    expect(worker).toContain("ctx.secrets.resolve");
    expect(worker).not.toContain("ctx.localFolders");
  });

  it("does not claim a capability it has no use for", () => {
    // Least privilege: no sidebar, no page route, no plugin-owned state, and no
    // company enumeration — the last one is what a scheduled job would have needed.
    for (const unwanted of [
      "ui.sidebar.register",
      "ui.page.register",
      "plugin.state.write",
      "companies.read",
      "jobs.schedule",
      // Not needed since the request location became derived: declaring it made the
      // host ask the operator to choose a directory.
      "local.folders",
    ]) {
      expect(manifest.capabilities).not.toContain(unwanted);
    }
  });

  it("declares no scheduled job, because the runner owns the schedule", () => {
    // A job is plugin-wide and this configuration is per-company, so a job could
    // only check every company by enumerating them. The runner runs continuously
    // and already has a schedule; the plugin writes requests on demand.
    expect(manifest.jobs ?? []).toHaveLength(0);
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
      "rag",
      "refresh",
      "sources",
    ]);
  });
});
