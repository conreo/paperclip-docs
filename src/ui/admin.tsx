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

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
  type OperatorSource,
} from "../config.js";
import { sanitizeErrorMessage } from "../errors.js";
import { describeIndexLine, type BuildProgress } from "../index-build.js";
import {
  buildCompanyBindingBody,
  buildProfileCreateBody,
  buildProfileEntryBody,
  findProfileId,
  isAlreadyExistsMessage,
  profileEntriesPath,
  profilesPath,
  summarizeGrant,
  type GrantState,
} from "../grant.js";
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
  /** Present when the builder wrote a vector index; null when there is none. */
  embeddings: {
    model: string;
    dim: number;
    count: number;
    complete: boolean;
    bundles: string[];
    builtAt: string;
  } | null;
  /** An index build in flight, read from the indexer's own journal. */
  build: BuildProgress | null;
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

      <ToolsGrant companyId={companyId} onMessage={notify} />

      <Configuration
        companyId={companyId}
        onSaved={refresh}
        onMessage={notify}
        // The allowlist is unusable without the names to type, so the corpus
        // inventory is passed in rather than left to the placeholder — which used
        // to name products from a different corpus entirely.
        availableBundles={status?.bundles ?? []}
        embeddings={status?.embeddings ?? null}
        build={status?.build ?? null}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent access
// ---------------------------------------------------------------------------

/**
 * Whether an agent may actually call the tools.
 *
 * Registration is not access. Paperclip refuses a plugin tool until a tool
 * profile names it, and a manifest cannot declare that access — so the reference
 * CodeGraph plugin ships a "Make the tools callable" action and this plugin, until
 * now, shipped nothing. The four tools were registered, the corpus was found,
 * enabled, full and fresh, and every other line on this page was green for a week
 * while every call was refused: those indicators answer "does the plugin work",
 * and this one answers "may an agent use it".
 *
 * The button creates this plugin's own company-scoped profile and binds it. It
 * only ever adds: an existing profile is reused, and a complete grant is left
 * alone.
 */
function ToolsGrant({ companyId, onMessage }: { companyId: string; onMessage: Notify }) {
  const [state, setState] = useState<GrantState | null>(null);
  const [reading, setReading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    setReading(true);
    try {
      setState(summarizeGrant(await coreApi(profilesPath(companyId))));
      setReadError(null);
    } catch (cause) {
      setState(null);
      setReadError(sanitizeErrorMessage(cause));
    } finally {
      setReading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void read();
  }, [read]);

  const grant = useCallback(async () => {
    setBusy(true);
    try {
      const collection = profilesPath(companyId);
      let profileId = state?.profileId ?? null;
      let reused = false;

      if (!profileId) {
        try {
          const created = await coreApi<{ id?: unknown }>(collection, {
            method: "POST",
            body: buildProfileCreateBody(),
          });
          profileId = typeof created?.id === "string" && created.id.length > 0 ? created.id : null;
        } catch (cause) {
          const text = cause instanceof Error ? cause.message : String(cause);
          if (!isAlreadyExistsMessage(text)) throw cause;
          reused = true;
          profileId = findProfileId(await coreApi(collection));
        }
        if (!profileId) {
          throw new Error("The profile exists but its id could not be read back from the board.");
        }
      }

      // A profile that already exists but is missing tools is repaired one entry
      // at a time. A partial grant is exactly the state that used to look fine
      // here, so it is worth being able to fix without deleting anything.
      if (reused) {
        for (const toolName of state?.missing ?? []) {
          try {
            await coreApi(profileEntriesPath(profileId), {
              method: "POST",
              body: buildProfileEntryBody(toolName),
            });
          } catch (cause) {
            const text = cause instanceof Error ? cause.message : String(cause);
            if (!isAlreadyExistsMessage(text)) throw cause;
          }
        }
      }

      try {
        await coreApi(`${collection}/${profileId}/bind`, {
          method: "POST",
          body: buildCompanyBindingBody(companyId),
        });
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : String(cause);
        if (!isAlreadyExistsMessage(text)) throw cause;
      }

      await read();
      onMessage(
        "The four documentation tools are now callable by this organization's agents.",
        "success",
      );
    } catch (cause) {
      onMessage(`Could not make the tools callable: ${sanitizeErrorMessage(cause)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [companyId, onMessage, read, state?.missing, state?.profileId]);

  const complete = state?.complete === true;
  const missing = state?.missing ?? [];

  return (
    <Section
      title="Agent access"
      description="Whether an agent may actually call these tools. Registration is not access: Paperclip refuses a plugin tool until a tool profile names it, and nothing grants these four by default."
    >
      {reading && !state ? (
        <p style={styles.muted}>Checking what agents may call…</p>
      ) : readError ? (
        <div style={styles.errorBanner}>Could not read the tool profile: {readError}</div>
      ) : (
        <ul style={styles.list}>
          <StatusLine
            ok={complete}
            good="All four tools are callable by this organization's agents"
            bad={
              missing.length === 0
                ? "No profile grants these tools, so every call is refused"
                : `${missing.length} of 4 tools are not granted (${missing
                    .map((tool) => tool.replace(`${PLUGIN_ID}:`, ""))
                    .join(", ")}) — an agent calling one is refused`
            }
          />
          {state && state.granted.length > 0 ? (
            <p style={styles.note}>
              Granted:{" "}
              {state.granted.map((tool) => tool.replace(`${PLUGIN_ID}:`, "")).join(", ")}.
              {state.profileId ? ` Profile ${state.profileId}.` : ""}
            </p>
          ) : null}
        </ul>
      )}

      {complete ? null : (
        <div style={styles.row}>
          <Button
            label={busy ? "Granting…" : "Make the tools callable"}
            disabled={busy || reading}
            onClick={() => void grant()}
          />
          <span style={styles.hint}>
            Creates a company-scoped &ldquo;Docs (read-only)&rdquo; profile and binds it. Safe to run
            twice — it reuses what it already made, and never takes a tool away.
          </span>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------------

/** A heading, a sentence, and its controls. One idea per section. */
/**
 * The registry, as rows.
 *
 * This was the last setting with no control anywhere: `sources` was in the schema from
 * the first version, the runner refuses a build request without it, and the live config
 * of a working board held `[]` — so "Request a rebuild now" produced a request that
 * nothing would honour, and no page could fix it. Adding a source is data, not code, so
 * this is the whole of the per-organization work.
 */
const SOURCE_KINDS = ["git", "wiki", "llms", "local"] as const;

/** Where a source actually lives, named the way each kind names it. */
const SOURCE_LOCATION: Record<string, { label: string; placeholder: string; key: keyof OperatorSource }> = {
  git: { label: "Repository", placeholder: "https://github.com/owner/repo", key: "repo" },
  wiki: { label: "Wiki URL", placeholder: "https://wiki.example.com", key: "url" },
  llms: { label: "llms.txt URL", placeholder: "https://example.com/llms.txt", key: "url" },
  local: { label: "Folder", placeholder: "/srv/handbook", key: "path" },
};

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function SourcesEditor({
  sources,
  disabled,
  onChange,
  onMessage,
}: {
  sources: OperatorSource[];
  disabled: boolean;
  onChange: (next: OperatorSource[]) => void;
  onMessage: Notify;
}) {
  const patch = (index: number, edits: Partial<OperatorSource>) =>
    onChange(
      sources.map((source, position) => (position === index ? { ...source, ...edits } : source)),
    );

  return (
    <>
      {sources.length === 0 ? (
        <p style={styles.fieldHint}>
          No sources are declared, so a rebuild request has nothing to fetch and the runner refuses it
          with “request declares no sources”. The corpus on disk still works; this is only about
          rebuilding it.
        </p>
      ) : null}

      {sources.map((source, index) => {
        const location = SOURCE_LOCATION[source.kind] ?? SOURCE_LOCATION.git!;
        return (
          <div key={`${source.id}-${index}`} style={sourceStyles.row}>
            <div style={sourceStyles.head}>
              <strong style={sourceStyles.name}>{source.id || "unnamed source"}</strong>
              <Button
                label="Remove"
                disabled={disabled}
                onClick={() => onChange(sources.filter((_, position) => position !== index))}
              />
            </div>

            <Field
              label="Bundle name"
              value={source.id}
              disabled={disabled}
              placeholder="postgresql-16"
              onCommit={(value) => {
                const next = value.trim();
                if (next.length === 0) {
                  onMessage("A source needs a bundle name.", "error");
                  return;
                }
                if (next.includes("/")) {
                  onMessage("A bundle name cannot contain a slash — it is the folder name.", "error");
                  return;
                }
                if (sources.some((other, position) => position !== index && other.id === next)) {
                  onMessage(`${next} is already declared.`, "error");
                  return;
                }
                patch(index, { id: next });
              }}
            />

            <label style={sourceStyles.selectLabel}>
              <span style={sourceStyles.caption}>Kind</span>
              <select
                value={source.kind}
                disabled={disabled}
                style={sourceStyles.select}
                onChange={(event) => patch(index, { kind: event.target.value })}
              >
                {SOURCE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </label>

            <Field
              label={location.label}
              value={(source[location.key] as string | undefined) ?? ""}
              disabled={disabled}
              placeholder={location.placeholder}
              onCommit={(value) => patch(index, { [location.key]: value.trim() } as Partial<OperatorSource>)}
            />

            <Field
              label="Version to pin"
              value={source.ref ?? ""}
              disabled={disabled}
              placeholder="v16 (empty: the default branch)"
              onCommit={(value) => patch(index, { ref: value.trim() })}
            />

            <Field
              label="Include globs (comma separated)"
              value={(source.include ?? []).join(", ")}
              disabled={disabled}
              placeholder="**/*.md"
              onCommit={(value) => patch(index, { include: splitList(value) })}
            />

            <Field
              label="Exclude globs (comma separated)"
              value={(source.exclude ?? []).join(", ")}
              disabled={disabled}
              placeholder="archive/**, **/changelog.md"
              onCommit={(value) => patch(index, { exclude: splitList(value) })}
            />
          </div>
        );
      })}

      <div style={styles.row}>
        <Button
          label="Add a source"
          disabled={disabled}
          onClick={() =>
            onChange([
              ...sources,
              { id: "new-bundle", kind: "git", repo: "https://github.com/owner/repo" },
            ])
          }
        />
        <span style={styles.hint}>
          Placeholder values, on purpose — rename the bundle and point it at a real repository. An
          incomplete source fails the build rather than guessing.
        </span>
      </div>
    </>
  );
}

const sourceStyles: Record<string, CSSProperties> = {
  row: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: "12px 14px",
    border: "1px solid var(--border, #e4e7ec)",
    borderRadius: 10,
    marginBottom: 10,
  },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  name: { fontSize: 13, fontWeight: 600 },
  selectLabel: { display: "flex", flexDirection: "column", gap: 4 },
  caption: { fontSize: 12, fontWeight: 600, letterSpacing: 0.3, textTransform: "uppercase", opacity: 0.7 },
  select: {
    padding: "6px 8px",
    borderRadius: 8,
    border: "1px solid var(--border, #e4e7ec)",
    background: "var(--background, #fff)",
    color: "inherit",
    fontSize: 14,
  },
};

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
 * A group of sections under one idea — OKF, RAG.
 *
 * The page had grown a flat list where the corpus and the ranking settings sat
 * next to each other with no marker, and the semantic settings were inside an
 * "Advanced" disclosure. Grouping them is the difference between "here are eleven
 * settings" and "here is the corpus, and here is the optional ranking on top of it".
 */
/**
 * A dashboard card: one idea, its current state, and its controls in one block.
 *
 * The page used to be a flat column of eighteen sections, which made "is my corpus
 * working?" a reading exercise. The state pill answers that before anything is read,
 * and it is computed from the same values the sections use — never a second guess at
 * the truth.
 */
function Card({
  title,
  description,
  state,
  children,
}: {
  title: string;
  description: string;
  state?: { label: string; tone: "ok" | "off" | "warn" };
  children: ReactNode;
}) {
  return (
    <section style={cardStyles.card}>
      <header style={cardStyles.header}>
        <div style={cardStyles.heading}>
          <h2 style={cardStyles.title}>{title}</h2>
          <p style={cardStyles.body}>{description}</p>
        </div>
        {state ? (
          <span
            style={{
              ...cardStyles.pill,
              ...(state.tone === "ok"
                ? cardStyles.pillOk
                : state.tone === "warn"
                  ? cardStyles.pillWarn
                  : cardStyles.pillOff),
            }}
          >
            {state.label}
          </span>
        ) : null}
      </header>
      <div style={cardStyles.content}>{children}</div>
    </section>
  );
}

const cardStyles: Record<string, CSSProperties> = {
  card: {
    display: "flex",
    flexDirection: "column",
    border: "1px solid var(--border, #e4e7ec)",
    borderRadius: 12,
    marginTop: 18,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    padding: "14px 16px",
    background: "var(--muted, #f9fafb)",
    borderBottom: "1px solid var(--border, #e4e7ec)",
  },
  heading: { display: "flex", flexDirection: "column", gap: 4 },
  title: { fontSize: 13, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", margin: 0 },
  body: { fontSize: 13, color: "var(--muted-foreground, #667085)", margin: 0, lineHeight: 1.5, maxWidth: 620 },
  pill: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: 999,
    whiteSpace: "nowrap",
    border: "1px solid transparent",
  },
  pillOk: { background: "rgba(16, 122, 72, 0.12)", color: "#107a48", borderColor: "rgba(16, 122, 72, 0.25)" },
  pillWarn: { background: "rgba(180, 83, 9, 0.12)", color: "#b45309", borderColor: "rgba(180, 83, 9, 0.25)" },
  pillOff: { background: "rgba(102, 112, 133, 0.12)", color: "#667085", borderColor: "rgba(102, 112, 133, 0.25)" },
  content: { display: "flex", flexDirection: "column", padding: "4px 16px 12px" },
};

/**
 * A determinate progress bar.
 *
 * Determinate on purpose: the indexer journals one `concept_id` per embedded
 * vector, so the count is real rather than a spinner pretending to be progress.
 */
function Progress({ label, percent }: { label: string; percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div style={progressStyles.wrap}>
      <div style={progressStyles.label}>{label}</div>
      <div
        style={progressStyles.track}
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div style={{ ...progressStyles.fill, width: `${clamped}%` }} />
      </div>
    </div>
  );
}

const progressStyles: Record<string, CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", gap: 6 },
  label: { fontSize: 13, lineHeight: 1.4 },
  track: {
    height: 6,
    borderRadius: 999,
    background: "var(--border, #e4e7ec)",
    overflow: "hidden",
  },
  fill: { height: "100%", background: "var(--primary, #16150f)", transition: "width 400ms ease" },
};

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
  embeddings,
  build,
}: {
  companyId: string;
  onSaved: () => void;
  onMessage: Notify;
  availableBundles: Array<{ name: string; conceptCount: number }>;
  embeddings: CorpusStatus["embeddings"];
  build: CorpusStatus["build"];
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

  /**
   * Prove the embedding endpoint before semantic retrieval is switched on.
   *
   * The probe runs in the worker, through the same egress client the query path
   * uses, so a pass means "a search will be able to embed its query" — which a
   * request from this page could not establish. It is required before the switch
   * can be turned on, because the alternative is what happened here: RAG on, a
   * query that quietly stayed keyword-only, and no way to tell.
   */
  const runValidateRag = usePluginAction(ACTION_KEYS.validateRag);
  const [probe, setProbe] = useState<{ state: "idle" | "busy" | "ok" | "error"; message: string }>({
    state: "idle",
    message: "",
  });
  const [validatedFor, setValidatedFor] = useState<string | null>(null);
  const ragKey = draft
    ? `${draft.rag.endpoint.trim()}|${draft.rag.model.trim()}|${draft.rag.secretRef.trim()}`
    : "";
  const validated = validatedFor !== null && validatedFor === ragKey;

  const probeEndpoint = useCallback(async () => {
    if (!draft) return;
    setProbe({ state: "busy", message: "Asking the endpoint to embed one string…" });
    try {
      const outcome = (await runValidateRag({
        companyId,
        endpoint: draft.rag.endpoint.trim(),
        model: draft.rag.model.trim(),
        secretRef: draft.rag.secretRef.trim(),
      })) as
        | {
            ok?: boolean;
            dim?: number;
            ms?: number;
            error?: string;
            matchesIndex?: boolean | null;
          }
        | undefined;
      if (outcome?.ok) {
        setValidatedFor(ragKey);
        const mismatch =
          outcome.matchesIndex === false
            ? " The index on disk was built with a different model or width, so ranking would be meaningless until it is rebuilt."
            : "";
        setProbe({
          state: "ok",
          message: `The endpoint answered with ${outcome.dim} dimensions in ${
            outcome.ms ?? "?"
          } ms.${mismatch}`,
        });
        return;
      }
      setValidatedFor(null);
      setProbe({ state: "error", message: outcome?.error ?? "The endpoint did not answer." });
    } catch (error) {
      setValidatedFor(null);
      setProbe({ state: "error", message: sanitizeErrorMessage(error) });
    }
  }, [companyId, draft, ragKey, runValidateRag]);

  // An already-configured organization should not have to press a button to learn
  // that what it has is working, so one check runs by itself.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (autoChecked.current) return;
    if (!draft?.rag.enabled || !draft.rag.endpoint || !draft.rag.model) return;
    autoChecked.current = true;
    void probeEndpoint();
  }, [draft, probeEndpoint]);

  /**
   * Ask the runner to rebuild the index without re-fetching the corpus.
   *
   * The cheap way back: after a model change, or when a corpus rebuild took the
   * index with it. Reported the same way the rebuild button reports — the runner's
   * own reply, not an assumption that the work happened.
   */
  const runRebuildIndex = usePluginAction(ACTION_KEYS.rebuildIndex);
  const [indexBusy, setIndexBusy] = useState(false);
  const rebuildIndex = useCallback(async () => {
    setIndexBusy(true);
    try {
      const outcome = (await runRebuildIndex({ companyId })) as
        | { written?: boolean; skipped?: string; path?: string; model?: string }
        | undefined;
      if (outcome?.written) {
        onMessage(
          `Index rebuild requested for ${outcome.model ?? "the configured model"} (${outcome.path}). Nothing is fetched — the runner embeds the corpus already on this server.`,
          "success",
        );
      } else {
        onMessage(`No request written: ${outcome?.skipped ?? "the host returned nothing"}`, "error");
      }
    } catch (error) {
      onMessage(sanitizeErrorMessage(error), "error");
    } finally {
      setIndexBusy(false);
    }
  }, [runRebuildIndex, companyId, onMessage]);

  /**
   * Delete one bundle from the corpus, and its vectors with it.
   *
   * Confirmed first, and the confirmation says what actually happens rather than
   * "are you sure?": the pages are removed from disk, their vectors go with them,
   * nothing is re-fetched, and hiding the bundle instead is one click away.
   */
  const runPruneBundle = usePluginAction(ACTION_KEYS.pruneBundle);
  const [removing, setRemoving] = useState("");
  const removeBundle = useCallback(
    async (bundle: string, pages: number) => {
      const question =
        `Delete ${bundle} (${pages} ${pages === 1 ? "page" : "pages"}) from the corpus on disk?\n\n` +
        `The pages are removed and their vectors are dropped from the index. Nothing is ` +
        `re-fetched and nothing is re-embedded, so this is quick. It cannot be undone ` +
        `from this page.\n\n` +
        `To stop agents reading it without deleting it, switch it off instead.`;
      if (typeof window !== "undefined" && !window.confirm(question)) return;

      setRemoving(bundle);
      try {
        const outcome = (await runPruneBundle({ companyId, bundle })) as
          | { written?: boolean; skipped?: string; path?: string; present?: boolean }
          | undefined;
        if (outcome?.written) {
          onMessage(
            outcome.present === false
              ? `${bundle} was not in the corpus, so nothing was deleted.`
              : `Deletion of ${bundle} requested (${outcome.path}). The runner removes the pages and their vectors — no fetch, no re-embedding.`,
            outcome.present === false ? "error" : "success",
          );
          onSaved();
        } else {
          onMessage(`Nothing requested: ${outcome?.skipped ?? "the host returned nothing"}`, "error");
        }
      } catch (error) {
        onMessage(sanitizeErrorMessage(error), "error");
      } finally {
        setRemoving("");
      }
    },
    [runPruneBundle, companyId, onMessage, onSaved],
  );

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
      <Card
        title="OKF"
        description="The corpus itself: where it lives, what to build, which parts of it this organization may read, and how it is refreshed. Nothing here changes how results are ranked."
        state={
          !draft.enabled
            ? { label: "Tools off", tone: "off" }
            : names.length === 0
              ? { label: "No corpus", tone: "warn" }
              : {
                  label: `${readable.length} of ${names.length} bundle${names.length === 1 ? "" : "s"} readable`,
                  tone: readable.length === 0 ? "warn" : "ok",
                }
        }
      >

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
        title="Corpus directory"
        description="Where this organization's OKF corpus is. It is read by the Paperclip worker, so it must be a path inside the environment Paperclip runs in — '~' is the worker's home, which in a container is not yours. Empty means no corpus, and every tool refuses."
      >
        <Field
          value={draft.corpusRoot}
          disabled={busy}
          placeholder="~/offline-docs/okf-bundles"
          label="Corpus directory"
          onCommit={(value) => void write({ corpusRoot: value.trim() }, "Corpus directory updated.")}
        />
      </Section>

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
                  {/* Rendered, not only announced. The host's switch takes its text
                      as an aria-label, so a list of them without this is a column of
                      unnamed toggles — which is exactly what it looked like. */}
                  <span style={styles.bundleLabel}>{bundle.name}</span>
                  <span style={styles.bundleCount}>
                    {bundle.conceptCount} {bundle.conceptCount === 1 ? "page" : "pages"}
                  </span>
                  {/* Two different removals, deliberately side by side. Switching the
                      bundle off stops agents reading it and is reversible in a click;
                      this deletes the pages from disk. Until now the page offered only
                      the first and called it "which bundles agents may read", which is
                      not the same question as "what is still in the corpus". */}
                  <Button
                    label={removing === bundle.name ? "Requesting…" : "Delete"}
                    disabled={busy || removing.length > 0}
                    onClick={() => void removeBundle(bundle.name, bundle.conceptCount)}
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

      <Section
        title="Sources to build"
        description="This organization's registry: what to fetch, and which version of it. Adding a source is data, not code, so this is the whole of the per-organization work. It is only used when a build is requested — nothing here changes what agents can read right now."
      >
        <SourcesEditor
          sources={draft.sources}
          disabled={busy}
          onMessage={onMessage}
          onChange={(next) => void write({ sources: next }, "Sources updated.")}
        />
      </Section>

      <Section
        title="Rebuilding"
        description="This plugin cannot fetch anything: the runtime gives it no way to run git or pandoc. Collaborating with a runner on the host, it writes a request; the runner performs the build and writes the corpus."
      >
        {/* The schedule itself, which had no control at all: `refresh.enabled` was in
            the schema from the first version and stayed false forever, so the only way
            a rebuild ever happened was a person pressing the button below. */}
        <div style={styles.row}>
          <Switch
            checked={draft.refresh.enabled}
            disabled={busy}
            label="Let the schedule ask for a rebuild when the corpus is older than the age below"
            onChange={(next) =>
              void write(
                { refresh: { ...draft.refresh, enabled: next } },
                next
                  ? "This organization may be asked to rebuild on a schedule."
                  : "Scheduled rebuilds are off for this organization.",
              )
            }
          />
          <span style={styles.hint}>
            {draft.refresh.enabled
              ? "A scheduled check may write a rebuild request when the corpus is older than the age below."
              : "Nothing will ask for a rebuild on a schedule. The button below still works."}
          </span>
        </div>
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
      </details>
      </Card>

      <Card
        title="RAG"
        description="Ranking by meaning, on top of keyword search rather than instead of it. It needs two things outside this page: an embedding endpoint, and a vector index written by your host's indexer. The plugin only reads the index."
        state={
          !draft.rag.enabled
            ? { label: "Keyword only", tone: "off" }
            : embeddings
              ? {
                  label: `${embeddings.count.toLocaleString("en-US")} vectors · ${embeddings.model}`,
                  tone: embeddings.complete ? "ok" : "warn",
                }
              : { label: "On, but no index", tone: "warn" }
        }
      >

      <Section
        title="Semantic retrieval"
        description={'Ranking by meaning, on top of keyword search rather than instead of it. Keyword search needs none of this and stays the baseline. What it buys: a page that says "single sign-on" is found by the query SSO, which no amount of keyword tuning will do.'}
      >
        {/* A build in flight comes first: it is the answer to "why is this taking
            so long?", and this page is the only place it can be seen — the
            indexer runs on the host and says nothing between start and finish. */}
        {build?.active ? (
          <Progress
            label={`Building the vector index — ${build.done.toLocaleString("en-US")}${
              build.total > 0 ? ` of ${build.total.toLocaleString("en-US")}` : ""
            } concepts (${build.percent}%)`}
            percent={build.percent}
          />
        ) : build?.interrupted ? (
          <div style={styles.bannerWarning}>
            <strong>An index build stopped before it finished.</strong>
            <p style={styles.bannerBody}>
              {build.done.toLocaleString("en-US")}
              {build.total > 0 ? ` of ${build.total.toLocaleString("en-US")}` : ""} concepts were
              embedded and no index was written — a killed build leaves its journal behind. Start it
              again on the host; it resumes from where it stopped.
            </p>
          </div>
        ) : null}

        <p style={styles.fieldHint}>
          {embeddings
            ? describeIndexLine(embeddings)
            : "The corpus has no index, so this cannot work yet. The index is not built here: it is written by the indexer on your host when it is given the same endpoint, and the plugin only reads it."}
        </p>
        <p style={styles.fieldHint}>
          These settings control the *query*: which endpoint embeds the text an agent searches
          for, and how much the semantic ranking counts against the keyword one. The index itself —
          which model, which pages — is decided where it is built, so changing the model here does
          not rebuild anything, and a model that disagrees with the index makes ranking meaningless.
        </p>

        <Field
          value={draft.rag.endpoint}
          disabled={busy}
          placeholder="https://api.example.com/v1/embeddings"
          label="Embeddings endpoint"
          onCommit={(value) => void write({ rag: { ...draft.rag, endpoint: value } }, "Endpoint updated.")}
        />
        <p style={styles.fieldHint}>
          Must be an address Paperclip's outbound fetch allows. It refuses private IPv4 — 10/8, 172.16/12,
          192.168/16, 127/8 and link-local — so an embedding server on your LAN is <em>not</em> reachable
          from the worker, and setting one leaves semantic retrieval quietly falling back to keyword
          search. A tailnet address (100.64/10) is allowed. Use <strong>Validate endpoint</strong> below:
          it makes the call through the worker, which is the only check that proves this address works.
        </p>
        <Field
          value={draft.rag.model}
          disabled={busy}
          placeholder="bge-small"
          label="Embedding model"
          onCommit={(value) => void write({ rag: { ...draft.rag, model: value } }, "Model updated.")}
        />
        <Field
          value={draft.rag.secretRef}
          disabled={busy}
          placeholder="(a stored secret reference)"
          label="API key reference"
          onCommit={(value) => void write({ rag: { ...draft.rag, secretRef: value } }, "Key reference updated.")}
        />

        <div style={styles.row}>
          <Button
            label={probe.state === "busy" ? "Checking…" : "Validate endpoint"}
            disabled={
              busy ||
              probe.state === "busy" ||
              draft.rag.endpoint.trim().length === 0 ||
              draft.rag.model.trim().length === 0
            }
            onClick={() => void probeEndpoint()}
          />
          <span style={styles.hint}>
            Calls the endpoint from the worker with one throwaway string, the same way a search does.
          </span>
        </div>

        <div style={styles.row}>
          <Button
            label={indexBusy ? "Requesting…" : "Rebuild index"}
            disabled={
              indexBusy ||
              !draft.rag.enabled ||
              draft.rag.endpoint.trim().length === 0 ||
              draft.rag.model.trim().length === 0
            }
            onClick={() => void rebuildIndex()}
          />
          <span style={styles.hint}>
            Embeds the corpus already on this server. Nothing is fetched, so this is the cheap way
            back after a model change or a lost index.
          </span>
        </div>
        {probe.state === "ok" ? (
          <p style={styles.fieldHint}>✓ {probe.message}</p>
        ) : probe.state === "error" ? (
          <div style={styles.errorBanner}>{probe.message}</div>
        ) : probe.state === "busy" ? (
          <p style={styles.fieldHint}>{probe.message}</p>
        ) : (
          <p style={styles.fieldHint}>
            Validate before switching this on: an endpoint that is unreachable, a wrong key, or a
            model that disagrees with the index all leave search working and silently keyword-only.
          </p>
        )}

        <Switch
          checked={draft.rag.enabled}
          disabled={busy || (!draft.rag.enabled && !validated)}
          label="Also rank by meaning"
          onChange={(next) =>
            void write(
              { rag: { ...draft.rag, enabled: next } },
              next ? "Semantic retrieval on." : "Semantic retrieval off; keyword search only.",
            )
          }
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

        {/* Also in the schema since the first version, and also with no control: the
            blend draws this many candidates from the index before ranking them, so
            without it the number was whatever the default happened to be. */}
        <Field
          value={String(draft.rag.topK)}
          disabled={busy || !draft.rag.enabled}
          placeholder="20"
          label="Candidates from the index"
          numeric
          onCommit={(value) => {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isFinite(parsed) || parsed < 1 || parsed > 500) {
              onMessage("Candidates from the index must be a whole number between 1 and 500.", "error");
              return;
            }
            void write({ rag: { ...draft.rag, topK: parsed } }, "Index candidates updated.");
          }}
        />
      </Section>
      </Card>
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
