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

import { DOC_TOOLS, PLUGIN_ID, PLUGIN_VERSION, REQUESTS_FOLDER_KEY } from "../src/constants.js";

describe("manifest", () => {
  it("identifies the plugin and its API version", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.id).toBe("paperclip-docs");
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(manifest.version).toBe("0.2.0");
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
      // Writes one request file into a folder the operator declares. The corpus
      // itself is still only read, with `node:fs`.
      "local.folders",
      // Resolves the embedding key by reference, so the value stays in the host.
      "secrets.read-ref",
    ]);
  });

  it("declares a local-folder capability only because it writes one", () => {
    // This replaces a test that asserted `local.folders` was absent. Absence was
    // the right claim until refresh requests existed; now the claim that matters is
    // that the capability is *used*, so it is checked against the source rather
    // than against a wish.
    const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(worker).toContain("ctx.localFolders");
    // The other two are used too, and this is the assertion that keeps that true:
    // an egress capability granted for a feature that never calls out is a
    // permission an operator gave for nothing.
    expect(worker).toContain("ctx.http.fetch");
    expect(worker).toContain("ctx.secrets.resolve");
    // And that the write goes to a declared folder, not to an arbitrary path.
    expect(manifest.localFolders?.map((folder) => folder.folderKey)).toEqual([REQUESTS_FOLDER_KEY]);
    expect(manifest.localFolders?.[0]?.access).toBe("readWrite");
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
