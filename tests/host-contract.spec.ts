/**
 * The manifest and config schema, validated by the *host's own* code.
 *
 * `manifest.spec.ts` asserts the manifest against this project's expectations,
 * which catches drift but cannot answer the question that decides an install:
 * **will Paperclip accept this?** A capability string that reads correctly but is
 * absent from the host's vocabulary is a manifest the host refuses, and the error
 * it returns names the string rather than the intent.
 *
 * So this file imports the host's shipped constants and schema rather than
 * restating them:
 *
 *   - `PLUGIN_CAPABILITIES` — the 79-string vocabulary a typo must miss;
 *   - `PLUGIN_UI_SLOT_TYPES` — the slot names;
 *   - `PLUGIN_CATEGORIES`, `PLUGIN_API_VERSION`;
 *   - `pluginManifestV1Schema` — the Zod schema the host parses the manifest with.
 *
 * ## What the shared schema does *not* check
 *
 * `pluginManifestV1Schema` is **structural**. It has been verified, while writing
 * this file, to accept a manifest carrying an invented capability and to accept a
 * settings slot with `instance.settings.register` removed. Vocabulary membership
 * and the slot→capability pairing are enforced by the *server's* capability
 * validator, which is not part of the published `@paperclipai/shared` — so a
 * purely local test cannot delegate those rules to the host, and this file
 * asserts them itself. That is the honest split: structure from the host,
 * vocabulary and pairing from here.
 */

import { describe, expect, it } from "vitest";
import {
  PLUGIN_API_VERSION,
  PLUGIN_CATEGORIES,
  PLUGIN_CAPABILITIES,
  PLUGIN_UI_SLOT_TYPES,
} from "@paperclipai/shared";
import { pluginManifestV1Schema } from "@paperclipai/shared/validators/plugin";

import manifest from "../src/manifest.js";
import { OPERATOR_CONFIG_DEFAULTS } from "../src/config.js";

describe("the host's vocabulary", () => {
  it("accepts every capability the manifest declares", () => {
    for (const capability of manifest.capabilities) {
      expect(
        PLUGIN_CAPABILITIES,
        `"${capability}" is not in the host's capability vocabulary`,
      ).toContain(capability);
    }
  });

  it("accepts every category and every slot type", () => {
    for (const category of manifest.categories ?? []) {
      expect(PLUGIN_CATEGORIES).toContain(category);
    }
    for (const slot of manifest.ui?.slots ?? []) {
      expect(PLUGIN_UI_SLOT_TYPES).toContain(slot.type);
    }
  });

  it("declares the API version the host currently serves", () => {
    expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("declares the capability that permits the slot it takes", () => {
    // The host refuses a settings slot without this, naming the capability in the
    // error. Asserted here as well because the shared schema does not check it —
    // see the file comment.
    expect(manifest.ui?.slots?.map((slot) => slot.type)).toContain("settingsPage");
    expect(manifest.capabilities).toContain("instance.settings.register");
  });
});

describe("the host's manifest schema", () => {
  it("accepts the manifest as authored", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    // The issues are printed rather than counted: a rejected manifest is a wall of
    // Zod paths, and the first one is the answer.
    expect(result.success, result.success ? "" : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });
});

describe("the config schema the host validates saved config against", () => {
  it("exposes exactly the keys the operator editor offers", () => {
    // The editor and the schema are two views of one contract; when they drift, a
    // field renders that the host then refuses to save — which is the failure the
    // CodeGraph plugin shipped once and had to fix.
    const schema = manifest.instanceConfigSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      Object.keys(OPERATOR_CONFIG_DEFAULTS).sort(),
    );
  });

  it("keeps the schema closed", () => {
    const schema = manifest.instanceConfigSchema as { additionalProperties?: unknown };
    expect(schema.additionalProperties).toBe(false);
  });
});
