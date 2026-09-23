/**
 * The documentation tool surface as Paperclip sees it.
 *
 * These declarations are static. Paperclip reads plugin tools from the manifest
 * at load time, before the worker has ever run, so the schema has to describe the
 * tools without the corpus being present. That is also what makes a *disabled*
 * plugin honest: with `enabled: false` the worker refuses every call, and an
 * agent sees tools that exist but decline rather than tools that silently
 * disappear mid-run.
 *
 * Descriptions are written for the model that reads them, not for a human
 * skimming a settings page: they say when to reach for the tool, what comes
 * back, and — for the two expensive ones — what not to do.
 */

import type { DocToolName } from "../constants.js";

export interface DocToolParam {
  type: "string" | "number" | "boolean";
  description: string;
  enum?: readonly string[];
  default?: string | number | boolean;
}

export interface DocToolSpec {
  /** Tool name, exposed to agents as `paperclip-docs:<name>`. */
  name: DocToolName;
  displayName: string;
  description: string;
  params: Record<string, DocToolParam>;
  required: readonly string[];
}

export const DOC_TOOL_SPECS: readonly DocToolSpec[] = [
  {
    name: "search_docs",
    displayName: "Search Documentation",
    description:
      "PRIMARY tool — call this FIRST for any question about the software this corpus documents: how to configure X, which options exist, an error message, an API field. Searches locally-installed vendor documentation and returns ranked concepts with a short snippet. Follow up with read_doc on the concept_id that looks right. Results are a snapshot of documentation at a point in time — the `timestamp` on each result says when it was captured.",
    params: {
      query: {
        type: "string",
        description:
          "What to look for. Terms are matched against titles, tags, descriptions, headings and body text; all terms must match unless nothing matches all of them, in which case a looser any-term search runs and the result says so.",
      },
      bundle: {
        type: "string",
        description:
          "Restrict the search to one product's bundle (for example `n8n` or `grafana`). Use list_docs or sources to see which bundles exist.",
      },
      type: {
        type: "string",
        description:
          "Restrict results to one concept type, as recorded in frontmatter (for example `Guide`, `Reference`, `API Reference`). Case-insensitive.",
      },
      limit: {
        type: "number",
        description: "Maximum results to return (default 5). The operator's configured ceiling always wins.",
        default: 5,
      },
    },
    required: ["query"],
  },
  {
    name: "read_doc",
    displayName: "Read Documentation Page",
    description:
      "Read one documentation concept in full: its frontmatter metadata and its markdown body. Pass the concept_id returned by search_docs or list_docs (for example `n8n/integrations/builtin/app-nodes/foo.md`). Very long pages are truncated at the operator's configured character cap and the truncation is marked explicitly in the returned text.",
    params: {
      concept_id: {
        type: "string",
        description:
          "Corpus-relative path of the concept, using forward slashes, ending in `.md`. Must stay inside the corpus: absolute paths and `..` segments are refused.",
      },
    },
    required: ["concept_id"],
  },
  {
    name: "list_docs",
    displayName: "List Documentation",
    description:
      "Browse the documentation tree one level at a time, for when you do not know what to search for. With no arguments it returns the corpus root index. A directory that has an index.md returns that index; otherwise the tool synthesises a listing of child directories (with concept counts) and child pages (with their descriptions). Pass a bundle, and optionally a path inside it.",
    params: {
      bundle: {
        type: "string",
        description: "Top-level bundle to browse (for example `nextcloud`). Omit to browse the corpus root.",
      },
      path: {
        type: "string",
        description:
          "Directory inside the bundle, or a `.md` file to open (for example `docs.n8n.io/integrations`). May also be given without `bundle`, in which case its first segment is the bundle.",
      },
    },
    required: [],
  },
  {
    name: "sources",
    displayName: "Documentation Sources",
    description:
      "Report what documentation is installed and how old it is: the corpus root, every bundle with its concept count, the total number of concepts, and the oldest and newest capture timestamps in the corpus. Call this before answering a question whose correctness depends on the docs being current, so the answer can be qualified with the snapshot's age instead of implying the documentation is up to date. Requires no arguments.",
    params: {},
    required: [],
  },
] as const;

/** Lookup by tool name. */
export const DOC_TOOL_SPEC_BY_NAME: ReadonlyMap<string, DocToolSpec> = new Map(
  DOC_TOOL_SPECS.map((spec) => [spec.name, spec]),
);

/** All tool names, in declaration order. */
export const ALL_DOC_TOOL_NAMES: readonly string[] = DOC_TOOL_SPECS.map((spec) => spec.name);

/** JSON Schema for one tool, as required by `PluginToolDeclaration`. */
export function toJsonSchema(spec: DocToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, param] of Object.entries(spec.params)) {
    const property: Record<string, unknown> = {
      type: param.type,
      description: param.description,
    };
    if (param.enum) property["enum"] = [...param.enum];
    if (param.default !== undefined) property["default"] = param.default;
    properties[key] = property;
  }
  return {
    type: "object",
    properties,
    required: [...spec.required],
    additionalProperties: false,
  };
}
