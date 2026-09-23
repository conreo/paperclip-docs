/**
 * Docs' settings, following the structure of Paperclip's own General settings
 * page — and of the reference CodeGraph plugin's page, so the two feel like the
 * same product.
 *
 * The shape is taken from `ui/src/pages/InstanceGeneralSettings.tsx` rather than
 * invented, because a plugin page that invents its own layout reads as unfinished
 * next to the app around it:
 *
 *   - a `max-w-4xl` column of spaced sections, one idea each;
 *   - a section is a `text-sm font-semibold` heading and a short muted sentence
 *     saying what it does;
 *   - a setting is saved **immediately** — no Save button anywhere, for either a
 *     switch or a text field, because General settings has none and a form that
 *     needs saving is one that can be abandoned half-changed;
 *   - a failure is one destructive-tinted banner, not a scattered message.
 *
 * ## Why the status section comes first
 *
 * This plugin's most likely failure is not a crash, it is an operator who
 * installed it and cannot tell whether the corpus was found. So the page leads
 * with the four facts that answer that — is it on, where is the corpus, how much
 * is in it, and how old is it — before it shows a single control.
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  usePluginAction,
  usePluginData,
  usePluginToast,
  type PluginSettingsPageProps,
  type PluginToastTone,
} from "@paperclipai/plugin-sdk/ui";

import { CORPUS_AGE_WARNING_DAYS, PLUGIN_ID } from "../constants.js";
import {
  effectiveBundles,
  operatorConfigForSave,
  readOperatorConfig,
  toggleBundle,
  type OperatorConfig,
} from "../config.js";
import { sanitizeErrorMessage } from "../errors.js";
import { ACTION_KEYS, DATA_KEYS } from "../plugin-keys.js";
import { StatusLine, styles, thumbTransform } from "./chrome.js";

/** The worker's status payload; keep in step with `StatusPayload` in handlers.ts. */
interface CorpusStatus {
  root: string;
  exists: boolean;
  enabled: boolean;
  totalConcepts: number;
  bundleCount: number;
  bundles: Array<{ name: string; conceptCount: number; newestTimestamp: string | null }>;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
  ageDays: number | null;
  stale: boolean;
  allowedBundles: string[];
  error: string | null;
  configError?: string | null;
}

type Tone = PluginToastTone;
type Notify = (text: string, tone: Tone) => void;

/** One credentialed call to the host's own API, as the signed-in board member. */
async function coreApi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? "GET",
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as Record<string, unknown>)["error"])
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return parsed as T;
}

export function SettingsPage({ context }: PluginSettingsPageProps) {
  const companyId = context.companyId;
  const toast = usePluginToast();

  const {
    data: status,
    loading,
    error,
    refresh,
  } = usePluginData<CorpusStatus>(DATA_KEYS.corpusStatus, { companyId });

  const notify: Notify = useCallback(
    (text, tone) => toast({ title: "Docs", body: text, tone }),
    [toast],
  );

  if (!companyId) {
    return (
      <div style={styles.page}>
        <p style={styles.body}>Open this page inside an organization to configure Docs.</p>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <header style={styles.title}>
        <h1 style={styles.h1}>Docs</h1>
        <p style={styles.lead}>
          Read-only documentation tools for your agents. They search and read a local, offline
          corpus — this plugin serves it, it does not build it.
        </p>
      </header>

      {error ? (
        <div style={styles.errorBanner}>
          Could not read the corpus status: {sanitizeErrorMessage(error)}
        </div>
      ) : null}

      {status?.configError ? (
        <div style={styles.errorBanner}>{status.configError}</div>
      ) : null}

      {status?.stale ? (
        <div style={styles.bannerWarning}>
          <strong>This corpus is {status.ageDays} days old.</strong>
          <p style={styles.bannerBody}>
            The newest document was captured {status.newestTimestamp ?? "unknown"}. Answers drawn
            from it may describe an older version of the software. Rebuild the corpus, then reopen
            this page to clear the warning.
          </p>
        </div>
      ) : null}

      <Section title="Status" description="What documentation this organization has right now.">
        {loading && !status ? (
          <p style={styles.muted}>Checking…</p>
        ) : (
          <>
            <ul style={styles.list}>
              <StatusLine
                ok={status?.enabled === true}
                good="Documentation tools are on for this organization"
                bad="Documentation tools are off — switch them on below"
              />
              <StatusLine
                ok={status?.exists === true}
                good={`Corpus found at ${status?.root ?? ""}`}
                bad={status?.error ?? "No corpus was found at the configured directory"}
              />
              <StatusLine
                ok={(status?.totalConcepts ?? 0) > 0}
                good={`${status?.totalConcepts ?? 0} concepts across ${status?.bundleCount ?? 0} bundle(s)`}
                bad="The corpus directory exists but contains no readable concepts"
              />
              <StatusLine
                ok={status?.ageDays !== null && status?.stale === false}
                good={`Newest capture ${status?.newestTimestamp ?? "unknown"} (${status?.ageDays ?? "?"} days old)`}
                bad={
                  status?.ageDays === null || status?.ageDays === undefined
                    ? "No capture timestamps were found in the corpus"
                    : `The newest capture is ${status.ageDays} days old — older than ${CORPUS_AGE_WARNING_DAYS} days, so these docs may be out of date`
                }
              />
            </ul>
            {status && status.bundles.length > 0 ? (
              <div style={styles.bundleGrid}>
                {status.bundles.map((bundle) => (
                  <div key={bundle.name} style={styles.bundleCell}>
                    <span style={styles.bundleName}>{bundle.name}</span>
                    <span style={styles.bundleCount}>{bundle.conceptCount}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {status ? (
              <p style={styles.note}>
                Oldest capture {status.oldestTimestamp ?? "unknown"} · newest{" "}
                {status.newestTimestamp ?? "unknown"}.
                {status.allowedBundles.length > 0
                  ? ` Agents may read only: ${status.allowedBundles.join(", ")}.`
                  : " Agents may read every bundle."}
              </p>
            ) : null}
          </>
        )}
      </Section>

      <Configuration
        companyId={companyId}
        onSaved={refresh}
        onMessage={notify}
        // The allowlist is unusable without the names to type, so the corpus
        // inventory is passed in rather than left to the placeholder — which used
        // to name products from a different corpus entirely.
        availableBundles={status?.bundles ?? []}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------------

/** A heading, a sentence, and its controls. One idea per section. */
function Section({
  title,
  description,
  children,
  control,
}: {
  title: string;
  description: string;
  children?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <section style={styles.section}>
      <div style={control ? styles.sectionSplit : styles.sectionStack}>
        <div style={styles.sectionText}>
          <h2 style={styles.h2}>{title}</h2>
          <p style={styles.body}>{description}</p>
        </div>
        {control}
      </div>
      {children ? <div style={styles.sectionBody}>{children}</div> : null}
    </section>
  );
}

/**
 * The switch, matching the host's `ToggleSwitch`.
 *
 * Capsule track, oval thumb, and the host's status-green when on — taken from
 * `ui/src/components/ui/toggle-switch.tsx`, including its deliberate choice of the
 * status colour over `primary`.
 */
function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      // The host's own hook (`data-slot="toggle"`), so anything that styles or
      // targets its switches by that attribute finds this one too.
      data-slot="toggle"
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        ...styles.switch,
        ...(checked ? styles.switchOn : styles.switchOff),
        ...(disabled ? styles.switchDisabled : null),
      }}
    >
      <span style={{ ...styles.thumb, transform: thumbTransform(checked) }} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function Configuration({
  companyId,
  onSaved,
  onMessage,
  availableBundles,
}: {
  companyId: string;
  onSaved: () => void;
  onMessage: Notify;
  availableBundles: Array<{ name: string; conceptCount: number }>;
}) {
  const path = `/api/plugins/${PLUGIN_ID}/config?companyId=${encodeURIComponent(companyId)}`;
  const [stored, setStored] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<OperatorConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // The bundle list is rendered from what the corpus *has*, and each row's state
  // comes from the same "empty means everything" rule the stored value uses — so a
  // bundle cannot be invisible merely because the config does not mention it.
  const names = availableBundles.map((bundle) => bundle.name);
  const readable = draft ? effectiveBundles(names, draft.allowedBundles) : names;
  const staleNames = draft
    ? draft.allowedBundles.filter((name) => !names.includes(name))
    : [];

  useEffect(() => {
    let cancelled = false;
    coreApi<{ configJson?: unknown } | null>(path)
      .then((response) => {
        if (cancelled) return;
        const document =
          response && typeof response === "object" && "configJson" in response
            ? (response as { configJson?: unknown }).configJson
            : response;
        const record =
          typeof document === "object" && document !== null && !Array.isArray(document)
            ? (document as Record<string, unknown>)
            : {};
        setStored(record);
        setDraft(readOperatorConfig(document));
      })
      .catch((error) => {
        if (!cancelled) setFailure(sanitizeErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  /**
   * Ask the host to write a refresh request.
   *
   * The outcome is reported rather than assumed: "refresh is off", "no sources are
   * declared" and "the request was written" are three different answers, and an
   * operator pressing a button deserves the one that is true.
   */
  const runRequestRefresh = usePluginAction(ACTION_KEYS.requestRefresh);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const requestRefresh = useCallback(async () => {
    setRefreshBusy(true);
    try {
      const outcome = (await runRequestRefresh({ companyId })) as
        | { written?: boolean; skipped?: string; path?: string; policy?: string }
        | undefined;
      if (outcome?.written) {
        onMessage(`Rebuild requested (${outcome.path}). ${outcome.policy ?? ""}`.trim(), "success");
      } else {
        onMessage(`No request written: ${outcome?.skipped ?? "the host returned nothing"}`, "error");
      }
    } catch (error) {
      onMessage(sanitizeErrorMessage(error), "error");
    } finally {
      setRefreshBusy(false);
    }
  }, [runRequestRefresh, companyId, onMessage]);

  /** Write one change immediately, the way a General settings switch does. */
  const write = useCallback(
    async (edits: Partial<OperatorConfig>, announce?: string) => {
      if (!draft) return;
      setBusy(true);
      try {
        // Only the schema's own keys are sent: the server validates this payload
        // with a closed schema, so an extra key is a rejected request rather than
        // a preserved setting.
        const { config: configJson, droppedKeys } = operatorConfigForSave(stored, {
          ...draft,
          ...edits,
        });
        await coreApi(`/api/plugins/${PLUGIN_ID}/config`, {
          method: "POST",
          body: { companyId, configJson },
        });
        setStored(configJson);
        setDraft(readOperatorConfig(configJson));
        onSaved();
        if (droppedKeys.length > 0) {
          onMessage(
            `Saved. This plugin no longer uses ${droppedKeys.join(", ")}, so ${
              droppedKeys.length === 1 ? "it was" : "they were"
            } removed.`,
            "warn",
          );
        } else if (announce) {
          onMessage(announce, "success");
        }
      } catch (error) {
        onMessage(sanitizeErrorMessage(error), "error");
      } finally {
        setBusy(false);
      }
    },
    [companyId, draft, onMessage, onSaved, stored],
  );

  if (failure) {
    return (
      <Section title="Configuration" description="Settings for this organization.">
        <div style={styles.errorBanner}>
          Could not read the settings: {failure} Nothing was changed.
        </div>
      </Section>
    );
  }

  if (!draft) {
    return (
      <Section title="Configuration" description="Settings for this organization.">
        <p style={styles.muted}>Loading…</p>
      </Section>
    );
  }

  return (
    <>
      <Section
        title="Documentation tools"
        description="While this is off, every Docs tool call is refused, whatever an agent is otherwise allowed. It is off until you turn it on."
        control={
          <Switch
            checked={draft.enabled}
            disabled={busy}
            label="Enable documentation tools for this organization"
            onChange={(next) =>
              void write({ enabled: next }, next ? "Documentation tools are on." : "Documentation tools are off.")
            }
          />
        }
      />

      <Section
        title="Bundles agents may read"
        description="Which parts of this corpus this organization may read. These are the bundles that are actually in it — switch one off to keep agents away from it. Narrowing improves answers even when nothing is secret: a corpus of fourteen products answering a question about one is how an agent ends up citing the wrong product's documentation. This does not decide which agents may use these tools; that is the tool grants on each agent."
      >
        {availableBundles.length === 0 ? (
          <p style={styles.fieldHint}>
            No bundles are in the corpus yet, so there is nothing to choose. Build a corpus, or point
            this organization at one that has been built.
          </p>
        ) : (
          <>
            <ul style={styles.bundleList}>
              {availableBundles.map((bundle) => (
                <li key={bundle.name} style={styles.bundleRow}>
                  <Switch
                    checked={readable.includes(bundle.name)}
                    disabled={busy}
                    label={`${bundle.name} — ${bundle.conceptCount} ${
                      bundle.conceptCount === 1 ? "page" : "pages"
                    }`}
                    onChange={(next) =>
                      void write(
                        {
                          allowedBundles: toggleBundle(
                            names,
                            draft.allowedBundles,
                            bundle.name,
                            next,
                          ),
                        },
                        next
                          ? `Agents may read ${bundle.name}.`
                          : `Agents may no longer read ${bundle.name}.`,
                      )
                    }
                  />
                </li>
              ))}
            </ul>
            {staleNames.length > 0 && (
              <p style={styles.fieldHint}>
                Also configured, but not in the corpus: {staleNames.join(", ")}. Nothing matches them,
                so they have no effect.
              </p>
            )}
          </>
        )}
      </Section>

      <details style={styles.disclosure}>
        <summary style={styles.disclosureSummary}>Advanced</summary>
        <p style={styles.fieldHint}>
          These save as you edit them — on blur or Enter. There is no Save button, so a field cannot
          be left half-changed.
        </p>

      <Section
        title="Maximum search results"
        description="The hard ceiling on search results, whatever an agent asks for. Between 1 and 100."
      >
        <Field
          value={String(draft.maxResults)}
          disabled={busy}
          placeholder="10"
          label="Maximum search results"
          numeric
          onCommit={(value) => {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
              onMessage("Maximum search results must be a whole number between 1 and 100.", "error");
              return;
            }
            void write({ maxResults: parsed }, "Maximum search results updated.");
          }}
        />
      </Section>

      <Section
        title="Maximum document characters"
        description="How much of one document read_doc may return before it truncates and marks the cut. Between 500 and 400000. A very large value can push other context out of an agent's window."
      >
        <Field
          value={String(draft.maxDocChars)}
          disabled={busy}
          placeholder="40000"
          label="Maximum document characters"
          numeric
          onCommit={(value) => {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isFinite(parsed) || parsed < 500 || parsed > 400_000) {
              onMessage("Maximum document characters must be between 500 and 400000.", "error");
              return;
            }
            void write({ maxDocChars: parsed }, "Maximum document characters updated.");
          }}
        />
      </Section>

      <Section
        title="Semantic retrieval"
        description={'Off by default. Keyword search stays the baseline — this adds ranking by meaning, which is what finds a page that says "single sign-on" and never the letters SSO. Every failure falls back to keyword results and says so.'}
      >
        <Switch
          checked={draft.rag.enabled}
          disabled={busy}
          label="Also rank by meaning"
          onChange={(next) =>
            void write(
              { rag: { ...draft.rag, enabled: next } },
              next ? "Semantic retrieval on." : "Semantic retrieval off; keyword search only.",
            )
          }
        />
        <Field
          value={draft.rag.endpoint}
          disabled={busy || !draft.rag.enabled}
          placeholder="https://api.example.com/v1/embeddings"
          label="Embeddings endpoint"
          onCommit={(value) => void write({ rag: { ...draft.rag, endpoint: value } }, "Endpoint updated.")}
        />
        <Field
          value={draft.rag.model}
          disabled={busy || !draft.rag.enabled}
          placeholder="bge-small"
          label="Embedding model"
          onCommit={(value) => void write({ rag: { ...draft.rag, model: value } }, "Model updated.")}
        />
        <Field
          value={draft.rag.secretRef}
          disabled={busy || !draft.rag.enabled}
          placeholder="(a stored secret reference)"
          label="API key reference"
          onCommit={(value) => void write({ rag: { ...draft.rag, secretRef: value } }, "Key reference updated.")}
        />
        <Field
          value={String(draft.rag.weight)}
          disabled={busy || !draft.rag.enabled}
          placeholder="0.5"
          label="Weight (0 = keyword only, 1 = semantic only)"
          numeric
          onCommit={(value) => {
            const parsed = Number.parseFloat(value);
            if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
              onMessage("The weight must be between 0 and 1.", "error");
              return;
            }
            void write({ rag: { ...draft.rag, weight: parsed } }, "Weight updated.");
          }}
        />
      </Section>

      <Section
        title="Rebuilding"
        description="This plugin cannot fetch anything: the runtime gives it no way to run git or pandoc. Collaborating with a runner on the host, it writes a request; the runner performs the build and writes the corpus."
      >
        <Field
          value={String(draft.refresh.maxAgeDays)}
          disabled={busy}
          placeholder="30"
          label="Rebuild when older than (days)"
          numeric
          onCommit={(value) => {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3_650) {
              onMessage("The rebuild age must be between 1 and 3650 days.", "error");
              return;
            }
            void write(
              { refresh: { ...draft.refresh, maxAgeDays: parsed } },
              "Rebuild age updated.",
            );
          }}
        />
        <div style={styles.row}>
          <Button
            label={refreshBusy ? "Requesting…" : "Request a rebuild now"}
            disabled={refreshBusy}
            onClick={() => void requestRefresh()}
          />
          <span style={styles.hint}>
            Writes a request for this organization. Nothing is fetched by the plugin.
          </span>
        </div>
      </Section>
      </details>
    </>
  );
}

/** The one button this page needs, kept local so it matches the surrounding style. */
function Button({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "6px 12px",
        borderRadius: 6,
        border: "1px solid var(--border, #d0d5dd)",
        background: "transparent",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}

/**
 * A text field that writes immediately.
 *
 * There is no Save button on purpose. A field that needs saving is a field that
 * can be left half-edited, and it makes the page inconsistent with its own
 * switches. The commit points are blur and Enter, which is when the operator has
 * finished with the value: committing on every keystroke would write a corpus
 * path one character at a time.
 */
function Field({
  value,
  onCommit,
  disabled,
  placeholder,
  label,
  multiline,
  numeric,
}: {
  value: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  label: string;
  multiline?: boolean;
  numeric?: boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  const commit = useCallback(() => {
    // An empty value is treated as "no change" rather than a save: every one of
    // these fields is required, so committing an empty string would only produce
    // a server error where the operator meant to clear a typo.
    if (text.trim().length === 0 || text === value) {
      setText(value);
      return;
    }
    onCommit(text.trim());
  }, [onCommit, text, value]);

  const shared: CSSProperties = multiline
    ? { ...styles.textarea }
    : { ...styles.input };

  return (
    <div style={styles.field}>
      {multiline ? (
        <textarea
          aria-label={label}
          value={text}
          rows={4}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          style={shared}
        />
      ) : (
        <input
          aria-label={label}
          value={text}
          type={numeric ? "number" : "text"}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          style={shared}
        />
      )}
    </div>
  );
}
