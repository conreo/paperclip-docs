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
    "Serve an Open Knowledge Format (OKF) corpus to Paperclip agents as governed, read-only tools: search, read, browse, and report the snapshot's age. Each organization keeps a registry of the documentation it wants built and at which version; the plugin asks a runner on your host to build it. Keyword search is the baseline, with ranking by meaning as an option. Every call flows through Paperclip's tool gateway and audit log.",
  author: "conreo",
  categories: ["connector", "ui"],
  capabilities: [
    // Registering the four documentation tools for agents.
    "agent.tools.register",
    // Required by the settingsPage slot below. The host validates this pairing
    // and rejects the manifest without it, naming the capability in the error.
    "instance.settings.register",
    // No `local.folders`. It was declared so the refresh request could be written
    // into a folder the operator picked — which made Paperclip ask them to choose a
    // directory and mark the plugin "needs attention" until they did. A filesystem
    // path is a deployment detail, not a setting: the request goes to a location
    // derived from the corpus root, which the deployment already decided, and the
    // runner derives the same path.
    // The optional semantic path calls an embedding endpoint — through the host's
    // own client, which is the audited route. Node's `fetch` would work without
    // declaring anything, and that is exactly why it is not used: an undeclared
    // egress path is the same "third path that nothing governs" this plugin exists
    // to replace.
    "http.outbound",
    // The API key is a reference resolved at call time, so the value stays in the
    // host and never appears in this plugin's configuration document.
    "secrets.read-ref",
    // No `jobs.schedule`. A scheduled job is plugin-wide, but this configuration is
    // per-company — so a job could only check every company by reading the company
    // list and depending on each one having configured its request folder. The
    // schedule belongs to the runner instead, which is the process that is actually
    // running continuously, and the plugin writes requests on demand.
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
