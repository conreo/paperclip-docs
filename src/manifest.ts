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

import { PLUGIN_ID, PLUGIN_VERSION, REQUESTS_FOLDER_KEY } from "./constants.js";
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
    // The corpus is *read* with `node:fs` (no declaration needed), but a refresh
    // request is *written* — and the moment this plugin writes, the write is
    // declared and contained to a folder the operator chose, rather than being a
    // quiet `node:fs` call. `local.folders` covers exactly that one folder.
    "local.folders",
    // No `jobs.schedule`. A scheduled job is plugin-wide, but this configuration is
    // per-company — so a job could only check every company by reading the company
    // list and depending on each one having configured its request folder. The
    // schedule belongs to the runner instead, which is the process that is actually
    // running continuously, and the plugin writes requests on demand.
  ],
  localFolders: [
    {
      folderKey: REQUESTS_FOLDER_KEY,
      displayName: "Build requests",
      description:
        "Where this plugin writes a refresh request for a host-side runner to pick up. Nothing else is written here, and the corpus itself is never modified.",
      access: "readWrite",
    },
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
