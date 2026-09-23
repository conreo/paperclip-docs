/**
 * Plugin manifest.
 *
 * The `tools` array is the static surface Paperclip reads at load time, before
 * the corpus has been indexed — so it lists all four tools. Whether a given
 * company may actually call them is decided at call time from that company's
 * `enabled` flag, which is why a *disabled* plugin is honest: the tools exist
 * and decline, rather than vanishing from an agent's toolset mid-run.
 *
 * The slot list is deliberately one entry long. This plugin has no sidebar and
 * no page: a reader UI was considered and rejected, because the corpus already
 * ships its own progressive-disclosure index and the tools are the product. A
 * second renderer of the same markdown could only fall behind the first.
 */

import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

import { PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";
import { INSTANCE_CONFIG_SCHEMA } from "./config.js";
import { DOC_TOOL_SPECS, toJsonSchema } from "./tools/catalog.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Docs",
  description:
    "Serve a locally-installed offline documentation corpus (OKF bundles) to Paperclip agents as governed, read-only tools: search, read, browse, and report the snapshot's age. Every call flows through Paperclip's tool gateway and audit log.",
  author: "conreo",
  categories: ["connector", "ui"],
  capabilities: [
    // Registering the four documentation tools for agents.
    "agent.tools.register",
    // Required by the settingsPage slot below. The host validates this pairing
    // and rejects the manifest without it, naming the capability in the error.
    "instance.settings.register",
    // Nothing else. The corpus is read with `node:fs` directly, so there is no
    // `local.folders` declaration to make and no state to persist: this plugin
    // owns no data, it only reads an artifact the operator already built.
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "docs-settings",
        displayName: "Docs",
        exportName: "SettingsPage",
      },
    ],
  },
  instanceConfigSchema: INSTANCE_CONFIG_SCHEMA,
  tools: DOC_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    displayName: spec.displayName,
    description: spec.description,
    parametersSchema: toJsonSchema(spec),
  })),
};

export default manifest;
