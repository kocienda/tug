/**
 * SessionMetadataStore — subscribable store for Claude Code session metadata.
 *
 * Subscribes to a FeedStore and watches for `system_metadata` payloads on
 * the specified feed ID. Parses slash commands and skills into a merged
 * SlashCommandInfo array and exposes a CompletionProvider factory for the
 * `/` trigger.
 *
 * **Laws:** [L02] External state enters React through useSyncExternalStore only.
 * [L22] Observed by engine callbacks, not round-tripped through React.
 *
 * @module lib/session-metadata-store
 */

import type { FeedStore } from "./feed-store";
import type { FeedIdValue } from "../protocol";
import type { CompletionProvider, CompletionItem } from "./tug-text-types";
import { scoreCommandMatch } from "./text-match";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single slash command or skill entry from session metadata. */
export interface SlashCommandInfo {
  name: string;
  description?: string;
  category: "local" | "agent" | "skill";
  /**
   * Free-text argument hint for the command, when the emitter supplies one
   * (`{ name, argumentHint }` in a `session_capabilities` / `system_metadata`
   * command entry — e.g. `"<idea> → <output-path>"`). Drives the prompt
   * entry's post-acceptance argument placeholder; absent when the emitter
   * ships bare-string entries, in which case the placeholder falls back to a
   * generic slot for argument-taking command shapes.
   */
  argumentHint?: string;
}

/**
 * One model offered by the `initialize` control-response `models` list,
 * forwarded turn-free as a `session_capabilities` frame. The picker
 * ([#step-2b]) reads `value` (the `--model` selector) + `displayName`;
 * `models[0]` is the account default by convention (`value: "default"`,
 * `displayName: "Default (recommended)"`).
 */
export interface CapabilityModel {
  value: string;
  displayName: string;
  description?: string;
  /**
   * Whether this model supports reasoning effort ([#step-4]). Absent on the
   * wire (and here) when the model does not support it — e.g. haiku — so its
   * absence IS the "unsupported" signal that gates the effort chip.
   */
  supportsEffort?: boolean;
  /**
   * The effort levels this model supports, in the wire's order. Varies by
   * model (opus: `low|medium|high|xhigh|max`; sonnet drops `xhigh`), so the
   * picker offers the *active* model's list. Absent when effort is unsupported.
   */
  supportedEffortLevels?: string[];
}

/** Snapshot of the current session metadata state. */
export interface SessionMetadataSnapshot {
  sessionId: string | null;
  model: string | null;
  permissionMode: string | null;
  cwd: string | null;
  /**
   * Claude Code's stream-json format version (`system_metadata.version`,
   * e.g. `"2.1.105"`). `null` before the metadata event lands. Read by
   * the Session card's drift-caution surface to compare against the pinned
   * catalog version.
   */
  version: string | null;
  slashCommands: SlashCommandInfo[];
  /**
   * Available models from the turn-free `initialize` handshake
   * ([#step-2a]). Empty until the `session_capabilities` frame lands.
   * `models[0]` is the account default. Source for the `/model` picker
   * ([#step-2b]) and the model chip's pre-turn default-model label —
   * `initialize` does NOT carry the exact current model id, only this
   * list, so the chip shows `models[0].displayName` until a live
   * `system_metadata.model` (or the on-bind ledger replay) sharpens it.
   */
  models: CapabilityModel[];
  /**
   * The session's current reasoning-effort level ([#step-4]), from
   * `session_capabilities.effort`. `null` when no `--effort` override is in
   * force (the model runs at its built-in default, which the wire does not
   * expose) — the chip reads `null` as "Default". tugcode is the authority
   * (it owns the `--effort` flag); a client-initiated change reflects here
   * optimistically via {@link SessionMetadataStore.applyEffort}, since the
   * respawn-to-apply ([R07]) emits no fresh metadata for a resumed session.
   */
  effort: string | null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const EMPTY_SNAPSHOT: SessionMetadataSnapshot = {
  sessionId: null,
  model: null,
  permissionMode: null,
  cwd: null,
  version: null,
  slashCommands: [],
  models: [],
  effort: null,
};

// ── Reconciliation: two sources, one derived snapshot ──────────────────────────
//
// Session metadata arrives from two frames that overlap, and the public
// snapshot is the *derived reconciliation* of them — never a single mutable
// object patched in place by each (which is what made every new field a fresh
// chance to forget a "preserve across the other branch" rule). The two raw
// sources are held separately and the snapshot is recomputed by
// {@link reconcileSnapshot} on every change, so divergence is impossible by
// construction and field ownership lives in exactly one place. See memory
// `session-metadata-from-drop` for the from-the-drop discipline this encodes.

/**
 * The turn-free `initialize` handshake (`session_capabilities`) — available
 * from the drop, before any turn. Owns `models`, `effort`, the from-the-drop
 * command catalog (`commands`), and the Claude Code `version`.
 *
 * The version is tugcode-sourced, not from claude's `initialize` response
 * (which carries no version — only the post-turn `system_metadata` does).
 * tugcode runs `claude --version` at spawn and folds the result into the
 * handshake so the version surfaces from the drop, before the first turn —
 * the same locally-augmented-handshake pattern as the bundled plugin commands.
 */
interface CapabilitiesRegion {
  models: CapabilityModel[];
  effort: string | null;
  commands: SlashCommandInfo[];
  version: string | null;
}

const EMPTY_CAPABILITIES: CapabilitiesRegion = {
  models: [],
  effort: null,
  commands: [],
  version: null,
};

/**
 * A post-turn `system_metadata` frame — richer and authoritative, but only
 * after a turn runs. Owns the live `sessionId` / `model` / `permissionMode` /
 * `cwd` / `version`, and the authoritative command catalog (`slashCommands`,
 * merged from `slash_commands ∪ skills ∪ agents`).
 */
interface SystemRegion {
  sessionId: string | null;
  model: string | null;
  permissionMode: string | null;
  cwd: string | null;
  version: string | null;
  slashCommands: SlashCommandInfo[];
}

/**
 * Client-initiated optimistic overrides, pending the authoritative frame.
 * tugcode answers `set_model` / `set_permission_mode` with a `control_response`
 * (not fresh metadata), and a resumed `--effort` respawn emits no fresh
 * `session_capabilities` — so the chip reflects the change here immediately and
 * the override is dropped when the authoritative frame that owns the field
 * lands (`system_metadata` for model/mode, `session_capabilities` for effort).
 */
interface OptimisticOverrides {
  model?: string;
  permissionMode?: string;
  effort?: string;
}

/**
 * Derive the public snapshot from the two raw regions + optimistic overrides.
 * The single source of truth for field ownership and precedence — pure, so it
 * is trivially testable and adding a field is one line here.
 *
 * Precedence, per field:
 * - `models` / `effort` ← capabilities (effort: optimistic wins until a fresh
 *   handshake lands).
 * - `sessionId` / `model` / `permissionMode` / `cwd` ← system
 *   (model + mode: optimistic wins until the authoritative frame lands).
 * - `version` ← the from-the-drop handshake (`session_capabilities`),
 *   sharpened by the post-turn `system_metadata` when it lands. The
 *   handshake value (tugcode's `claude --version`) makes the badge correct
 *   on the very first card; system wins once a turn confirms claude's own
 *   reported version.
 * - `slashCommands` (the catalog — the only field both sources carry) ← the
 *   post-turn system catalog when non-empty, else the from-the-drop handshake
 *   catalog. So it is populated from the drop and sharpened post-turn, and an
 *   empty/sparse system frame never wipes a populated handshake catalog. The
 *   two are *merged* (not swapped) so the system list's authority over *which*
 *   commands exist never costs the handshake's richer per-command metadata —
 *   see {@link mergeCatalogs}.
 */
function reconcileSnapshot(
  cap: CapabilitiesRegion,
  sys: SystemRegion | null,
  opt: OptimisticOverrides,
): SessionMetadataSnapshot {
  return {
    sessionId: sys?.sessionId ?? null,
    model: opt.model ?? sys?.model ?? null,
    permissionMode: opt.permissionMode ?? sys?.permissionMode ?? null,
    cwd: sys?.cwd ?? null,
    version: sys?.version ?? cap.version ?? null,
    slashCommands:
      sys && sys.slashCommands.length > 0
        ? mergeCatalogs(sys.slashCommands, cap.commands)
        : cap.commands,
    models: cap.models,
    effort: opt.effort ?? cap.effort,
  };
}

/**
 * Merge the post-turn system catalog (the base) with the from-the-drop
 * capabilities catalog (the metadata source). The result is the **union** by
 * name: a command exists if either source reports it.
 *
 * Neither list is a superset of the other. By the first turn claude has loaded
 * plugins, so the system list carries plugin commands the turn-free handshake
 * may not have. But on a resumed card the system frame is the ledger's stored
 * copy from an *earlier* run, and the handshake is the only live source — a
 * project skill added since (a new `.claude/skills/<name>/`) is in the
 * handshake and nowhere else. Letting the stored list decide membership made
 * that skill unreachable, and the unknown-command guard then refused the very
 * turn whose `system/init` would have refreshed the list.
 *
 * The system emitter ships its entries as bare strings — no `argumentHint`, no
 * `description` — while the capabilities catalog carries that richer metadata
 * (tugcode reads it from each command's frontmatter). So every system entry is
 * kept and backfilled by name from the matching capabilities entry, and every
 * capabilities entry the system list lacks is appended as-is. Without the
 * backfill, an explicit argument hint shown from the drop would silently
 * regress to the generic slot the moment the first turn's sparse catalog
 * landed — the same command, hint lost on re-invocation.
 */
function mergeCatalogs(
  sys: SlashCommandInfo[],
  cap: SlashCommandInfo[],
): SlashCommandInfo[] {
  if (cap.length === 0) return sys;
  const capByName = new Map(cap.map((c) => [c.name, c]));
  const sysNames = new Set(sys.map((s) => s.name));
  const merged = sys.map((s) => {
    if (s.argumentHint !== undefined && s.description !== undefined) return s;
    const rich = capByName.get(s.name);
    if (rich === undefined) return s;
    return {
      ...s,
      argumentHint: s.argumentHint ?? rich.argumentHint,
      description: s.description ?? rich.description,
    };
  });
  for (const c of cap) {
    if (!sysNames.has(c.name)) merged.push(c);
  }
  return merged;
}

/**
 * Parse the `models` array of a `session_capabilities` payload. Keeps
 * only entries with a string `value` + `displayName`; `description` is
 * optional. Malformed entries are skipped (never throws) — mirrors
 * tugcode's `capabilities.ts` parser.
 */
function parseCapabilityModels(raw: unknown): CapabilityModel[] {
  if (!Array.isArray(raw)) return [];
  const out: CapabilityModel[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.value !== "string" || typeof obj.displayName !== "string") {
      continue;
    }
    const model: CapabilityModel = {
      value: obj.value,
      displayName: obj.displayName,
    };
    if (typeof obj.description === "string") model.description = obj.description;
    // Reasoning-effort capability ([#step-4]). `supportsEffort` is absent when
    // unsupported, so keep it only when present; `supportedEffortLevels` keeps
    // only its string elements. Mirrors tugcode's `capabilities.ts` parser.
    if (typeof obj.supportsEffort === "boolean") {
      model.supportsEffort = obj.supportsEffort;
    }
    if (Array.isArray(obj.supportedEffortLevels)) {
      model.supportedEffortLevels = obj.supportedEffortLevels.filter(
        (l): l is string => typeof l === "string",
      );
    }
    out.push(model);
  }
  return out;
}

/** Validate and normalize a category string. */
function toCategory(raw: unknown): "local" | "agent" | "skill" {
  if (raw === "agent" || raw === "skill") return raw;
  return "local";
}

/** Category priority for dedup: richer categories win over `local`. */
const CATEGORY_RANK: Record<SlashCommandInfo["category"], number> = {
  local: 0,
  skill: 1,
  agent: 1,
};

/**
 * Parse a raw entry from a `system_metadata` command-ish array (slash_commands,
 * skills, or agents) into a `SlashCommandInfo`, or null if malformed.
 *
 * Accepts two shapes because Claude Code's emitter has varied them:
 *   - Bare string — the current v2.1.105 payload ships `slash_commands`,
 *     `skills`, and `agents` as plain string arrays (e.g. `"tugplug:plan"`).
 *   - Object — `{ name, description?, category? }`, a forward-compatible
 *     shape if the emitter later adds metadata.
 */
function parseEntry(
  raw: unknown,
  defaultCategory: SlashCommandInfo["category"],
): SlashCommandInfo | null {
  if (typeof raw === "string" && raw.length > 0) {
    return { name: raw, category: defaultCategory };
  }
  if (raw && typeof raw === "object") {
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== "string" || !entry.name) return null;
    // The emitter has used both `argumentHint` and `argument_hint`; accept
    // either so a hint lands whichever the live build ships.
    const argHintRaw =
      typeof entry.argumentHint === "string"
        ? entry.argumentHint
        : typeof entry.argument_hint === "string"
          ? entry.argument_hint
          : undefined;
    return {
      name: entry.name,
      description:
        typeof entry.description === "string" ? entry.description : undefined,
      category:
        typeof entry.category === "string"
          ? toCategory(entry.category)
          : defaultCategory,
      argumentHint:
        argHintRaw !== undefined && argHintRaw.trim() !== ""
          ? argHintRaw
          : undefined,
    };
  }
  return null;
}

/**
 * Parse the `session_capabilities` `commands` array (the turn-free
 * `initialize`-handshake command catalog) into `SlashCommandInfo[]`. Each
 * entry is `{ name, description?, argumentHint? }`; reuse {@link parseEntry}
 * with the `local` category. Malformed entries are dropped.
 */
function parseCommandCatalog(raw: unknown): SlashCommandInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: SlashCommandInfo[] = [];
  for (const entry of raw) {
    const cmd = parseEntry(entry, "local");
    if (cmd) out.push(cmd);
  }
  return out;
}

/** Parse a system_metadata payload into a {@link SystemRegion}. Returns null if not system_metadata. */
function parseSystemRegion(payload: unknown): SystemRegion | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== "system_metadata") return null;

  // Merge slash_commands, skills, and agents into one list. Real v2.1.105
  // payloads overlap — every tugplug skill (e.g. `tugplug:plan`) is both
  // in `skills[]` (category: skill) and in `slash_commands[]` (category:
  // local). Dedup by name after merging, keeping the richer category.
  const merged: SlashCommandInfo[] = [];

  if (Array.isArray(p.slash_commands)) {
    for (const entry of p.slash_commands) {
      const cmd = parseEntry(entry, "local");
      if (cmd) merged.push(cmd);
    }
  }
  if (Array.isArray(p.skills)) {
    for (const entry of p.skills) {
      const skill = parseEntry(entry, "skill");
      if (skill) merged.push(skill);
    }
  }
  if (Array.isArray(p.agents)) {
    for (const entry of p.agents) {
      const agent = parseEntry(entry, "agent");
      if (agent) merged.push(agent);
    }
  }

  const byName = new Map<string, SlashCommandInfo>();
  for (const cmd of merged) {
    const prev = byName.get(cmd.name);
    if (!prev || CATEGORY_RANK[cmd.category] > CATEGORY_RANK[prev.category]) {
      byName.set(cmd.name, cmd);
    }
  }
  const slashCommands = Array.from(byName.values());

  return {
    sessionId: typeof p.session_id === "string" ? p.session_id : null,
    // An empty-string model is "no signal", not a model — claude's live
    // `system/init` emits `model: ""` when its init event omits the field
    // (`tugcode/src/session.ts`), and a stale durable replay can carry the
    // same. Normalize it to `null` here so the snapshot's `?? ` chain and
    // the no-clobber precedence below both treat it as absent rather than
    // resolving `resolveModelContextMax("")` to the 200K unknown default.
    model: typeof p.model === "string" && p.model.length > 0 ? p.model : null,
    // Wire emits `permissionMode` (camelCase) per
    // `tugcode/src/session.ts:498,517`. The earlier snake_case parse
    // key silently returned null for every live payload. An empty-string
    // mode is "no signal", not a mode — claude's live `system/init` emits
    // `permissionMode: ""` when its init event omits the field
    // (`tugcode/src/session.ts`), mirroring the `model: ""` case above.
    // Normalize it to `null` so the `resolvePermissionMode` `?? ` chain
    // falls back to `default` instead of rendering a blank chip.
    permissionMode:
      typeof p.permissionMode === "string" && p.permissionMode.length > 0
        ? p.permissionMode
        : null,
    cwd: typeof p.cwd === "string" ? p.cwd : null,
    version: typeof p.version === "string" ? p.version : null,
    slashCommands,
  };
}

// ── SessionMetadataStore ──────────────────────────────────────────────────────

/**
 * The read side of {@link SessionMetadataStore} — exactly what the metadata
 * consumers (the Z4B chips and the picker hooks) need: `subscribe` +
 * `getSnapshot`, nothing else. The concrete store satisfies it structurally,
 * so every existing call site is unchanged, while an alternative provider
 * (e.g. a defaults-backed adapter) can stand in wherever only reads happen.
 * The pickers route writes through their injected action callbacks, never
 * through the store's `apply*` mutators — this type is what enforces that.
 */
export type ReadableMetadataStore = Pick<
  SessionMetadataStore,
  "subscribe" | "getSnapshot"
>;

/**
 * SessionMetadataStore — L02-compliant store subscribing to FeedStore.
 *
 * Detects system_metadata payloads via reference comparison on the given feed.
 * Exposes subscribe/getSnapshot for useSyncExternalStore and
 * getCommandCompletionProvider() for the / trigger.
 */
export class SessionMetadataStore {
  // The two raw sources, held separately, plus optimistic overrides. The
  // public `_snapshot` is the DERIVED reconciliation of all three
  // ({@link reconcileSnapshot}) — never patched in place, so the views can
  // never diverge.
  private _capabilities: CapabilitiesRegion = EMPTY_CAPABILITIES;
  private _system: SystemRegion | null = null;
  private _optimistic: OptimisticOverrides = {};
  private _snapshot: SessionMetadataSnapshot = EMPTY_SNAPSHOT;
  private _listeners: Set<() => void> = new Set();
  private _unsubscribeFeed: (() => void) | null = null;
  private _lastPayloadRef: unknown = undefined;
  private _feedId: FeedIdValue;
  private _tugSessionId: string | null;

  constructor(
    feedStore: FeedStore,
    feedId: FeedIdValue,
    tugSessionId: string | null = null,
  ) {
    this._feedId = feedId;
    this._tugSessionId = tugSessionId;
    this._unsubscribeFeed = feedStore.subscribe(() => {
      this._onFeedUpdate(feedStore);
    });
    // Run an initial check in case data is already available.
    this._onFeedUpdate(feedStore);
  }

  private _onFeedUpdate(feedStore: FeedStore): void {
    const map = feedStore.getSnapshot();
    const payload = map.get(this._feedId);

    // Reference comparison: only process if the payload reference changed.
    if (payload === this._lastPayloadRef) return;
    this._lastPayloadRef = payload;
    this._processPayload(payload);
  }

  /**
   * Apply one decoded SESSION_SIDEBAND payload. Shared by the live feed path
   * ({@link _onFeedUpdate}) and the test injection ({@link _ingestForTest});
   * the reference-dedupe lives in `_onFeedUpdate`, so this always processes
   * what it is given.
   *
   * Two payload types ride the SESSION_SIDEBAND feed — `session_capabilities`
   * (turn-free handshake, [#step-2a]) and `system_metadata` (post-turn). Each
   * updates ONLY its own raw region; the public snapshot is then derived by
   * {@link reconcileSnapshot}. Because each source owns a region and the
   * snapshot is recomputed (not patched), one frame can never wipe a value the
   * other owns — the bug class that kept recurring.
   */
  private _processPayload(payload: unknown): void {
    // Session isolation, defense in depth ([D06]/[D11]). The per-card
    // FeedStore filter in `card-services-store.ts` is the primary gate;
    // this guard makes the invariant local to the store so a future
    // re-wiring cannot silently reintroduce cross-session contamination.
    // Only a payload that CARRIES a `tug_session_id` is checked — test /
    // gallery fixtures inject untagged payloads and must keep working.
    if (
      this._tugSessionId !== null &&
      typeof payload === "object" &&
      payload !== null
    ) {
      const tagged = (payload as Record<string, unknown>).tug_session_id;
      if (typeof tagged === "string" && tagged !== this._tugSessionId) {
        return;
      }
    }
    const payloadType =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).type
        : undefined;

    if (payloadType === "session_capabilities") {
      const cap = payload as Record<string, unknown>;
      this._capabilities = {
        models: parseCapabilityModels(cap.models),
        // tugcode surfaces the current effort level here (it owns `--effort`);
        // `null` when no override is in force ([#step-4]).
        effort: typeof cap.effort === "string" ? cap.effort : null,
        // The handshake carries the command catalog (`commands`) — available
        // from the drop, before the post-turn `system_metadata`. This is what
        // makes the [D14] popup filter + unknown-command detection ([#step-13a])
        // work on the very first input.
        commands: parseCommandCatalog(cap.commands),
        // tugcode's `claude --version`, folded into the handshake so the
        // Claude Code badge reads a real version from the drop instead of "?"
        // until the first turn's `system_metadata` lands.
        version: typeof cap.version === "string" ? cap.version : null,
      };
      // The authoritative effort just landed → drop any optimistic override.
      delete this._optimistic.effort;
      this._recompute();
      return;
    }

    const sys = parseSystemRegion(payload);
    if (!sys) return;
    // Whether THIS frame actually carried the field — read before the
    // no-clobber carry-forward below fills a blank model from history.
    const frameCarriedModel = sys.model !== null;
    const frameCarriedMode = sys.permissionMode !== null;
    // [P06] no-clobber precedence: a later `system_metadata` whose model is
    // absent (a live re-init that omitted `model`, or a stale/empty durable
    // replay frame) must NOT wipe a model that already resolved. The
    // JSONL-reconstructed / active model wins over a blank one. A real model
    // change (opus → sonnet) still replaces, since that incoming model is
    // non-null. Carry the last real model forward when the incoming is blank.
    if (sys.model === null && this._system?.model != null) {
      sys.model = this._system.model;
    }
    this._system = sys;
    // An optimistic override is superseded ONLY by a frame that actually
    // carries its field. A model-less frame (the turn-free synthetic
    // session_init, a sparse replay row) says nothing about the model — if
    // it dropped the override, a just-seeded pick (deck default → sonnet)
    // would flash and then snap back to the spawn model until the next real
    // turn. Same rule for permission mode.
    if (frameCarriedModel) delete this._optimistic.model;
    if (frameCarriedMode) delete this._optimistic.permissionMode;
    this._recompute();
  }

  /** Recompute the derived snapshot from the raw regions and notify. */
  private _recompute(): void {
    this._snapshot = reconcileSnapshot(
      this._capabilities,
      this._system,
      this._optimistic,
    );
    for (const listener of this._listeners) {
      listener();
    }
  }

  /** Subscribe to store updates. Returns an unsubscribe function. (L02) */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  /** Return the current session metadata snapshot. (L02) */
  getSnapshot = (): SessionMetadataSnapshot => {
    return this._snapshot;
  };

  /**
   * Test-only. Apply a decoded `session_capabilities` / `system_metadata`
   * payload as if it had landed on the feed, bypassing the connection. The
   * effort-chip app-test drives the Z4B chip with this via the `__tug` surface
   * (`ingestSessionMetadata`) — the chip reads its own `SESSION_SIDEBAND`
   * FeedStore, which the `driveSession`/`ingestFrame` (CodeSessionStore)
   * path does not reach.
   *
   * @internal — reached only through the DEV-gated `window.__tug` test surface.
   */
  _ingestForTest = (payload: unknown): void => {
    this._processPayload(payload);
  };

  /**
   * Optimistically reflect a client-initiated permission-mode change.
   *
   * tugcode is the authority for permission mode — it owns the
   * `--permission-mode` flag and forwards `set_permission_mode` to claude
   * — but claude answers with a `control_response`, not a fresh
   * `system_metadata`, so there is no round-trip to await. The terminal
   * updates its mode banner optimistically and so do we: the session card's
   * `Shift+Tab` / `/permissions` paths call this right after sending the
   * frame so the Z4B chip reflects the change immediately.
   *
   * Self-correcting: the override is dropped when the next authoritative
   * `system_metadata` lands (it owns `permissionMode`), and the reconciled
   * snapshot then reflects tugcode's value. A no-op when the mode is unchanged
   * (preserves snapshot reference stability for `useSyncExternalStore`).
   */
  applyPermissionMode(mode: string): void {
    if (this._snapshot.permissionMode === mode) return;
    this._optimistic = { ...this._optimistic, permissionMode: mode };
    this._recompute();
  }

  /**
   * Optimistically reflect a client-initiated model change.
   *
   * Like {@link applyPermissionMode}: claude answers a `set_model` control
   * request with a `control_response`, not a fresh `system_metadata`, so there
   * is no round-trip to await. The `/model` picker calls this right after
   * sending the frame so the Z4B model chip reflects the change immediately.
   * `model` is a resolved model id (e.g. `claude-sonnet-4-6`) so the chip's
   * `formatModelLabel` renders a friendly label. Self-correcting: the override
   * is dropped when the next authoritative `system_metadata` lands. A no-op
   * when unchanged (preserves snapshot reference stability).
   */
  applyModel(model: string): void {
    if (this._snapshot.model === model) return;
    this._optimistic = { ...this._optimistic, model };
    this._recompute();
  }

  /**
   * Optimistically reflect a client-initiated reasoning-effort change
   * ([#step-4]). Unlike model / permission mode, effort has no live control
   * verb — tugcode applies it by respawning claude with `--effort` + `--resume`
   * ([R07]) — and a resumed respawn emits no fresh `session_capabilities`, so
   * this optimistic override is the ONLY thing that moves the chip until a
   * fresh `session_capabilities` lands (which owns `effort`) and drops it. The
   * effort picker calls this right after sending the frame. A no-op when
   * unchanged (preserves snapshot reference stability for `useSyncExternalStore`).
   */
  applyEffort(effort: string): void {
    if (this._snapshot.effort === effort) return;
    this._optimistic = { ...this._optimistic, effort };
    this._recompute();
  }

  /**
   * Returns a CompletionProvider for the / trigger.
   * The provider closes over the store and reads current slashCommands on each call.
   * Matches and ranks by {@link scoreMatch} so the popup mirrors the `@`-file
   * popup: items carry highlight `matches` ranges and are ordered by match
   * quality (score descending, alphabetical tiebreak). An empty query offers
   * every command, alphabetically. Returns CompletionItem[] with
   * atom.type = "command".
   */
  getCommandCompletionProvider(): CompletionProvider {
    return (query: string): CompletionItem[] => {
      const { slashCommands } = this._snapshot;
      const ranked: Array<{ item: CompletionItem; score: number }> = [];
      for (const cmd of slashCommands) {
        const match = scoreCommandMatch(query, cmd.name);
        if (match === null) continue;
        ranked.push({
          score: match.score ?? 0,
          item: {
            label: cmd.name,
            atom: {
              kind: "atom",
              type: "command",
              label: cmd.name,
              value: cmd.name,
            },
            matches: match.matches.map(([s, e]) => [s, e] as [number, number]),
            description: cmd.description,
          },
        });
      }
      ranked.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.item.label.localeCompare(b.item.label, undefined, {
          sensitivity: "base",
        });
      });
      return ranked.map((r) => r.item);
    };
  }

  /** Unsubscribe from FeedStore and clear listeners. */
  dispose(): void {
    if (this._unsubscribeFeed) {
      this._unsubscribeFeed();
      this._unsubscribeFeed = null;
    }
    this._listeners.clear();
  }
}
