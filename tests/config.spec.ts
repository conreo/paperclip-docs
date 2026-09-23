import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  permitsBundle,
  effectiveBundles,
  toggleBundle,
  ConfigError,
  INSTANCE_CONFIG_SCHEMA,
  OPERATOR_CONFIG_DEFAULTS,
  operatorConfigForSave,
  readOperatorConfig,
  settableConfigKeys,
} from "../src/config.js";
import {
  DEFAULT_RUNTIME_CONFIG,
  expandHome,
  normalizeConfig,
} from "../src/runtime-config.js";
import { EXAMPLE_CORPUS_ROOT, DEFAULT_MAX_DOC_CHARS, DEFAULT_MAX_RESULTS } from "../src/constants.js";

describe("normalizeConfig defaults", () => {
  it("is disabled by default", () => {
    expect(normalizeConfig(undefined).enabled).toBe(false);
    expect(DEFAULT_RUNTIME_CONFIG.enabled).toBe(false);
  });

  it("defaults to no corpus at all, so nothing is served by accident", () => {
    // There is deliberately no shared default: one corpus root for every
    // organization is how a multi-tenant instance shows one organization another's
    // documents. The example in the docs is not a default.
    expect(normalizeConfig(undefined).corpusRoot).toBe("");
    expect(normalizeConfig({ enabled: true }, { home: "/home/tester" }).corpusRoot).toBe("");
    expect(EXAMPLE_CORPUS_ROOT).toContain("offline-docs");
  });

  it("defaults the allowlist to empty, meaning every bundle", () => {
    expect(normalizeConfig({}).allowedBundles).toEqual([]);
  });

  it("defaults the caps", () => {
    const config = normalizeConfig({});
    expect(config.maxResults).toBe(DEFAULT_MAX_RESULTS);
    expect(config.maxDocChars).toBe(DEFAULT_MAX_DOC_CHARS);
  });

  it("ships no corpus root at all, so no organization inherits another's", () => {
    // There is deliberately no default with a `~` in it any more. A shared default is
    // how every organization on a multi-tenant instance came to read the same corpus.
    expect(OPERATOR_CONFIG_DEFAULTS.corpusRoot).toBe("");
  });
});

describe("normalizeConfig accepts a full valid document", () => {
  it("reads every field", () => {
    const config = normalizeConfig(
      {
        enabled: true,
        corpusRoot: "/srv/docs/okf-bundles",
        allowedBundles: ["n8n", "grafana"],
        maxResults: 25,
        maxDocChars: 12_000,
      },
      { home: "/home/tester" },
    );
    expect(config).toEqual({
      enabled: true,
      corpusRoot: "/srv/docs/okf-bundles",
      allowedBundles: ["n8n", "grafana"],
      maxResults: 25,
      maxDocChars: 12_000,
      // The registry and the refresh policy default when a document predates them,
      // which is what keeps an older saved config loadable.
      refresh: { enabled: false, maxAgeDays: 30 },
      sources: [],
      // Semantic retrieval is off unless an endpoint is named; keyword search needs
      // no configuration at all.
      rag: { enabled: false, endpoint: "", model: "", secretRef: "", topK: 20, weight: 0.5 },
    });
  });

  it("expands a `~` corpusRoot", () => {
    const config = normalizeConfig({ corpusRoot: "~/docs" }, { home: "/home/tester" });
    expect(config.corpusRoot).toBe("/home/tester/docs");
  });
});

describe("normalizeConfig rejects a config it cannot understand", () => {
  it("rejects an unknown key by name", () => {
    try {
      normalizeConfig({ enable: true });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).field).toBe("enable");
      expect((error as ConfigError).message).toMatch(/unknown key/);
      // The message must say what *is* accepted, or the operator is stuck.
      expect((error as ConfigError).message).toContain("enabled");
    }
  });

  it("rejects an unknown key even when the rest is valid", () => {
    expect(() => normalizeConfig({ enabled: true, legacyThing: 1 })).toThrow(ConfigError);
  });

  it("rejects the wrong type for a boolean", () => {
    expect(() => normalizeConfig({ enabled: "true" })).toThrow(/must be a boolean/);
  });

  it("rejects a relative corpusRoot", () => {
    expect(() => normalizeConfig({ corpusRoot: "docs/okf" })).toThrow(/absolute path/);
  });

  it("rejects an out-of-range maxResults", () => {
    expect(() => normalizeConfig({ maxResults: 0 })).toThrow(/between/);
    expect(() => normalizeConfig({ maxResults: 1_000 })).toThrow(/between/);
  });

  it("rejects an out-of-range maxDocChars", () => {
    expect(() => normalizeConfig({ maxDocChars: 10 })).toThrow(/between/);
    expect(() => normalizeConfig({ maxDocChars: 10_000_000 })).toThrow(/between/);
  });

  it("rejects a non-finite number", () => {
    expect(() => normalizeConfig({ maxResults: Number.NaN })).toThrow(/finite/);
  });

  it("rejects a non-array allowlist", () => {
    expect(() => normalizeConfig({ allowedBundles: "n8n" })).toThrow(/array of strings/);
  });

  it("rejects an allowlist entry that is a path rather than a bundle name", () => {
    expect(() => normalizeConfig({ allowedBundles: ["n8n/../grafana"] })).toThrow(
      /plain bundle name/,
    );
  });

  it("rejects a non-object config", () => {
    expect(() => normalizeConfig([])).toThrow(/must be an object/);
    expect(() => normalizeConfig("nope")).toThrow(/must be an object/);
  });
});

describe("expandHome", () => {
  it("expands a bare tilde and a tilde-slash prefix, and nothing else", () => {
    expect(expandHome("~", "/home/tester")).toBe("/home/tester");
    expect(expandHome("~/docs", "/home/tester")).toBe("/home/tester/docs");
    expect(expandHome("/abs/docs", "/home/tester")).toBe("/abs/docs");
    expect(expandHome("~someone/docs", "/home/tester")).toBe("~someone/docs");
  });
});

describe("INSTANCE_CONFIG_SCHEMA", () => {
  const properties = INSTANCE_CONFIG_SCHEMA["properties"] as Record<
    string,
    Record<string, unknown>
  >;

  it("sets additionalProperties: false so unknown keys are rejected by the host", () => {
    expect(INSTANCE_CONFIG_SCHEMA["additionalProperties"]).toBe(false);
  });

  it("exposes exactly the documented keys", () => {
    expect(Object.keys(properties).sort()).toEqual([
      "allowedBundles",
      "corpusRoot",
      "enabled",
      "maxDocChars",
      "maxResults",
      "rag",
      "refresh",
      "sources",
    ]);
    expect(settableConfigKeys().sort()).toEqual(Object.keys(properties).sort());
  });

  it("gives every exposed field a default, so the page renders pre-filled", () => {
    for (const [key, schema] of Object.entries(properties)) {
      expect(schema["default"], `${key} needs a default`).toBeDefined();
    }
  });

  it("documents each field with a title and description", () => {
    for (const [key, schema] of Object.entries(properties)) {
      expect(schema["title"], `${key} needs a title`).toBeTruthy();
      expect(schema["description"], `${key} needs a description`).toBeTruthy();
    }
  });

  it("declares enabled with a false default", () => {
    expect(properties["enabled"]?.["default"]).toBe(false);
  });
});

describe("readOperatorConfig", () => {
  it("falls back to defaults rather than throwing on a drifted document", () => {
    expect(readOperatorConfig(null)).toEqual(OPERATOR_CONFIG_DEFAULTS);
    expect(readOperatorConfig("nonsense")).toEqual(OPERATOR_CONFIG_DEFAULTS);
    expect(readOperatorConfig({ enabled: "yes", maxResults: "lots" })).toEqual(
      OPERATOR_CONFIG_DEFAULTS,
    );
  });

  it("clamps an out-of-range number instead of refusing to render", () => {
    expect(readOperatorConfig({ maxResults: 10_000 }).maxResults).toBe(100);
    expect(readOperatorConfig({ maxDocChars: 1 }).maxDocChars).toBe(500);
  });

  it("reads a real document", () => {
    const config = readOperatorConfig({
      enabled: true,
      corpusRoot: "~/docs",
      allowedBundles: ["n8n", 7],
      maxResults: 3,
      maxDocChars: 900,
    });
    expect(config.enabled).toBe(true);
    expect(config.corpusRoot).toBe("~/docs");
    expect(config.allowedBundles).toEqual(["n8n"]);
    expect(config.maxResults).toBe(3);
    expect(config.maxDocChars).toBe(900);
  });
});

describe("operatorConfigForSave", () => {
  it("sends only the schema's keys and reports what it dropped", () => {
    const { config, droppedKeys } = operatorConfigForSave(
      { enabled: true, useDaemon: true, extraEnv: { A: "1" } },
      { maxResults: 7 },
    );
    expect(config).toEqual({ enabled: true, maxResults: 7 });
    expect(droppedKeys.sort()).toEqual(["extraEnv", "useDaemon"]);
  });

  it("ignores an edit for a key outside the schema", () => {
    const { config } = operatorConfigForSave({}, { notAKey: 1 } as never);
    expect(config).toEqual({});
  });
});

describe("granting bundles", () => {
  const discovered = ["grafana", "n8n", "restic"];

  it("grants nothing until something is ticked", () => {
    // Deny by default. The previous rule — empty means everything — is what let an
    // organization nobody had configured read every other organization's documents.
    expect(toggleBundle(discovered, [], "n8n", true)).toEqual(["n8n"]);
    expect(permitsBundle([], "n8n")).toBe(false);
  });

  it("removes and restores a single bundle, with no special cases", () => {
    const withN8n = toggleBundle(discovered, [], "n8n", true);
    expect(toggleBundle(discovered, withN8n, "n8n", false)).toEqual([]);
  });

  it("is the grant verbatim: ticking everything stores everything", () => {
    // No canonical empty form to get wrong. The earlier version collapsed a complete
    // set to [] — which meant *everything* — and that subtlety was the disclosure.
    let grant: string[] = [];
    for (const bundle of discovered) grant = toggleBundle(discovered, grant, bundle, true);
    expect(grant).toEqual(["grafana", "n8n", "restic"]);
    expect(permitsBundle(grant, "n8n")).toBe(true);
  });

  it("reports only the granted bundles the corpus actually has", () => {
    expect(effectiveBundles(discovered, ["n8n", "gone"])).toEqual(["n8n"]);
    expect(effectiveBundles(discovered, [])).toEqual([]);
  });
});
