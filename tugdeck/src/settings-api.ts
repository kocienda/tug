/**
 * Settings API client for tugcast.
 *
 * Read functions pull from the TugbankClient in-memory cache (populated via
 * the DEFAULTS WebSocket feed). Write functions PUT to the tugcast HTTP API.
 *
 * Domain/key mapping:
 *   Layout    → domain `dev.tugtool.deck.layout`,   key `layout`        (Value::Json)
 *   Theme     → domain `dev.tugtool.app`,            key `theme`         (Value::String)
 *   Card state → domain `dev.tugtool.deck.cardstate`, key `<cardId>`      (Value::Json) — `putCardState` / `readCardStates`
 *   Deck state→ domain `dev.tugtool.deck.state`,     key `focusedCardId` (Value::String)
 *
 * The tagged-value wire format is `{"kind":"json","value":{...}}` for JSON
 * values and `{"kind":"string","value":"brio"}` for strings.
 */

import type { CardStateBag, RegionScrollSnapshot } from "./layout-tree";
import type { TugbankClient, TaggedValue } from "./lib/tugbank-client";
import { logSessionLifecycle } from "./lib/session-lifecycle-log";
import { tugDevLogStore } from "./lib/tug-dev-log-store/tug-dev-log-store";
import { PERMISSION_MODE_DOMAIN } from "./lib/permission-mode";
import { MODEL_DOMAIN, PLAN_REVIEW_LAST_DOMAIN } from "./lib/model-domains";
import { TEXT_CARD_DOMAIN } from "./lib/text-card-settings";
import { IMAGE_CARD_DOMAIN } from "./lib/image-card-settings";
import { PDF_CARD_DOMAIN } from "./lib/pdf-card-settings";
import { getTugbankClient } from "./lib/tugbank-singleton";
import { canonicalizeDirPath } from "./lib/dir-existence";
import type { FindOptions } from "./lib/transcript-search";

const CARDSTATE_DOMAIN = "dev.tugtool.deck.cardstate";

/**
 * Cap a card-state bag before the tugbank write — the seam where the
 * **durable** copy is allowed to diverge from the full in-memory bag. The
 * in-memory `cardStateCache` keeps everything (so HMR Fast Refresh restores
 * a card byte-for-byte); this function decides what is worth persisting past
 * a page reload or app relaunch, both of which read only the durable copy.
 *
 * Two caps, both about size:
 *
 *  1. **`content.attachmentBytes`** — in-flight image-attachment payloads
 *     carried by the prompt entry. The bag is not dropped; each entry is
 *     reduced to a **reference**: `{content: "", mediaType, path}`, where
 *     `path` is where tugcast rested the original at drop time. What made
 *     the old wholesale strip necessary was size — base64 at megabytes
 *     scale, the bloat that once stalled boot at ~18 MB — and a path is
 *     tens of bytes. No image data of any kind is persisted here, not even
 *     the baked thumbnail: it is derivable from the bytes the restore is
 *     already fetching, and three of them written on every durable save
 *     (including the synchronous XHR at quit) would re-grow exactly the
 *     surface that caused the problem.
 *
 *     `content` is the empty string rather than an absent field on purpose:
 *     both filters on the restore path require `content` to be a string and
 *     skip the entry otherwise, and `buildWirePayload` already reads an
 *     empty `content` as "preview-only, do not ship" — so a not-yet-rehydrated
 *     entry falls through to a mention marker rather than shipping nothing.
 *
 *     An entry with no `path` — the upload was still in flight at quit, or
 *     it was refused — keeps `{content: "", mediaType}` and degrades exactly
 *     as every entry did before paths existed: its atom is pruned on restore
 *     (see `coerceRestorePayload`'s caller). [L23].
 *
 *  2. **`regionScroll[*].meta.cellHeights`** — a dead per-cell
 *     measured-height seed for the old `content-visibility` / estimate
 *     first-paint path; the transcript now renders every row at its real
 *     measured height, so there is no estimate to seed. Never written
 *     anymore, so this is purely a **migration** that removes the field
 *     from any legacy durable bag on the next save. The tiny `anchor` is
 *     always kept so a true reload still restores to the right cell.
 *
 * Exported for unit testing; callers use {@link putCardState}.
 */
/**
 * Reduce an `attachmentBytes` map to the references worth persisting, or
 * `null` when there is nothing left to write.
 *
 * Every surviving entry is `{content: "", mediaType, path?}` — no base64
 * payload, no thumbnail data URL, nothing else the in-memory entry happened
 * to carry. See {@link capDurableCardState}'s docblock for why the shape is
 * exactly this.
 */
function capAttachmentBytes(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as { mediaType?: unknown; path?: unknown };
    if (typeof e.mediaType !== "string") continue;
    out[id] =
      typeof e.path === "string" && e.path.length > 0
        ? { content: "", mediaType: e.mediaType, path: e.path }
        : { content: "", mediaType: e.mediaType };
    any = true;
  }
  return any ? out : null;
}

export function capDurableCardState(bag: CardStateBag): CardStateBag {
  let next = bag;

  // Cap 1 — attachment bytes become references (see docblock).
  if (
    next.content !== null &&
    typeof next.content === "object" &&
    "attachmentBytes" in (next.content as Record<string, unknown>)
  ) {
    const { attachmentBytes, ...restContent } =
      next.content as Record<string, unknown>;
    const capped = capAttachmentBytes(attachmentBytes);
    next = {
      ...next,
      content:
        capped === null ? restContent : { ...restContent, attachmentBytes: capped },
    };
  }

  // Cap 2 — dead cellHeights seed (migration, see docblock).
  if (next.regionScroll !== undefined && next.regionScroll !== null) {
    let changed = false;
    const capped: RegionScrollSnapshot = {};
    for (const [key, snap] of Object.entries(next.regionScroll)) {
      const meta = snap.meta as Record<string, unknown> | undefined | null;
      if (meta !== null && meta !== undefined && "cellHeights" in meta) {
        const { cellHeights: _drop, ...restMeta } = meta;
        void _drop;
        capped[key] = { x: snap.x, y: snap.y, meta: restMeta };
        changed = true;
      } else {
        capped[key] = snap;
      }
    }
    if (changed) next = { ...next, regionScroll: capped };
  }

  return next;
}

// ── Read functions (TugbankClient cache) ─────────────────────────────────────

/**
 * Read the deck layout from the TugbankClient cache.
 * Returns the unwrapped layout object, or null if not stored.
 */
export function readLayout(client: TugbankClient): object | null {
  const entry = client.get("dev.tugtool.deck.layout", "layout");
  if (entry && entry.kind === "json" && entry.value !== undefined) {
    return entry.value as object;
  }
  return null;
}

/**
 * Read the app theme from the TugbankClient cache.
 * Returns the theme string, or null if not stored.
 */
export function readTheme(client: TugbankClient): string | null {
  const entry = client.get("dev.tugtool.app", "theme");
  if (entry && entry.kind === "string" && typeof entry.value === "string") {
    return entry.value;
  }
  return null;
}

/**
 * Read the keyboard-access mode (`standard` / `accessibility`) from the
 * TugbankClient cache. Returns the raw string, or null if unset; the caller
 * normalizes it. Stored under `dev.tugtool.app` / `keyboardAccess`, the same
 * domain as the theme.
 */
export function readKeyboardAccess(client: TugbankClient): string | null {
  const entry = client.get("dev.tugtool.app", "keyboardAccess");
  if (entry && entry.kind === "string" && typeof entry.value === "string") {
    return entry.value;
  }
  return null;
}

/**
 * Read the focus-ring modality from the TugbankClient cache. Returns the raw
 * string, or null if unset; the caller normalizes it. Stored under
 * `dev.tugtool.app` / `focusRingModality`, the same domain as the theme.
 */
export function readFocusRingModality(client: TugbankClient): string | null {
  const entry = client.get("dev.tugtool.app", "focusRingModality");
  if (entry && entry.kind === "string" && typeof entry.value === "string") {
    return entry.value;
  }
  return null;
}


/**
 * Read the focused card ID from the TugbankClient cache.
 * Returns the string value, or null if not stored.
 */
export function readDeckState(client: TugbankClient): string | null {
  const entry = client.get("dev.tugtool.deck.state", "focusedCardId");
  if (entry && entry.kind === "string" && typeof entry.value === "string") {
    return entry.value;
  }
  return null;
}

/**
 * Read per-card state bags from the TugbankClient cache for the given card ids.
 * Returns a Map of cardId → CardStateBag for cards that have stored state under
 * `dev.tugtool.deck.cardstate`.
 *
 * Backward-compat coercion: persisted bags from before Phase E.11 stored
 * `{ kind: "component-owned" }` in `bag.focus` for engine-owned focus
 * targets. The current `FocusSnapshot` union names this variant
 * `engine`; the structure (no payload fields beyond `kind`) is
 * identical, so the rename is a pure relabel. We coerce on read so
 * downstream consumers see the post-E.11 shape exclusively. Bags
 * written by this client after Phase E.11 already carry
 * `kind: "engine"`; the coercion is a no-op for them.
 */
export function readCardStates(client: TugbankClient, cardIds: string[]): Map<string, CardStateBag> {
  const map = new Map<string, CardStateBag>();
  const domain = client.readDomain(CARDSTATE_DOMAIN);
  if (!domain) return map;

  for (const cardId of cardIds) {
    const entry = domain[cardId] as TaggedValue | undefined;
    if (entry && entry.kind === "json" && entry.value !== undefined) {
      map.set(cardId, coerceFocusSnapshotOnRead(entry.value as CardStateBag));
    }
  }
  return map;
}

/**
 * Coerce legacy `{ kind: "component-owned" }` in `bag.focus` to
 * `{ kind: "engine" }` on read. Information-preserving — the variants
 * are structurally identical and represent the same focus state — so
 * the rewrite is safe to apply unconditionally at the deserialization
 * boundary. Returns the input bag (possibly with a new `focus` field)
 * when a coercion fires, the same reference otherwise.
 */
function coerceFocusSnapshotOnRead(bag: CardStateBag): CardStateBag {
  const focus = bag.focus;
  if (focus === undefined || focus === null) return bag;
  // The persisted value may carry a kind string the current
  // `FocusSnapshot` union no longer names; cast through `unknown` to
  // read the legacy tag without losing type safety on the rewrite.
  if ((focus as unknown as { kind: string }).kind === "component-owned") {
    return { ...bag, focus: { kind: "engine" } };
  }
  return bag;
}

// ── Write functions (HTTP PUT, unchanged) ────────────────────────────────────

/**
 * PUT the deck layout to tugbank.
 *
 * Resolves `true` when tugbank accepted the write and `false` when the request
 * failed or came back non-2xx. Normal saves ignore the result; teardown-class
 * callers read it, because a write that never landed must be reported rather
 * than assumed ([L23]).
 */
export function putLayout(layout: object): Promise<boolean> {
  return fetch("/api/defaults/dev.tugtool.deck.layout/layout", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "json", value: layout }),
  })
    .then((response) => {
      if (!response.ok) {
        tugDevLogStore.warn("settings", "PUT layout rejected", {
          status: response.status,
        });
        return false;
      }
      return true;
    })
    .catch((err) => {
      tugDevLogStore.warn("settings", "PUT layout failed", { error: String(err) });
      return false;
    });
}

/**
 * PUT the app theme to tugbank (fire-and-forget).
 */
export function putTheme(theme: string): void {
  fetch("/api/defaults/dev.tugtool.app/theme", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: theme }),
  }).catch((err) => {
    console.warn("[settings] PUT theme failed:", err);
  });
}

/**
 * Persist the keyboard-access mode to tugbank under
 * `dev.tugtool.app` / `keyboardAccess`. Fire-and-forget, mirroring `putTheme`.
 */
export function putKeyboardAccess(mode: string): void {
  fetch("/api/defaults/dev.tugtool.app/keyboardAccess", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: mode }),
  }).catch((err) => {
    console.warn("[settings] PUT keyboardAccess failed:", err);
  });
}

/**
 * Persist the focus-ring modality to tugbank under
 * `dev.tugtool.app` / `focusRingModality`. Fire-and-forget, mirroring
 * `putKeyboardAccess`.
 */
export function putFocusRingModality(mode: string): void {
  fetch("/api/defaults/dev.tugtool.app/focusRingModality", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: mode }),
  }).catch((err) => {
    console.warn("[settings] PUT focusRingModality failed:", err);
  });
}


/**
 * Read the first-launch flag from the TugbankClient cache. `true` once the
 * user has been through ConfigureTug's first launch; `false`/absent means this is
 * a first run, so ConfigureTug shows itself up front (even before the auth probe
 * answers) instead of waiting behind a blank deck. Stored under
 * `dev.tugtool.app` / `setup-seen` (Value::Bool).
 */
export function readSetupSeen(client: TugbankClient): boolean {
  const entry = client.get("dev.tugtool.app", "setup-seen");
  return entry?.kind === "bool" && entry.value === true;
}

/**
 * Persist one command's keymap override — a JSON binding list, one tugbank
 * key per command id ([P14], Spec S04).
 *
 * Per-command keys are what make reset a `DELETE` and keep one rebind from
 * racing another; a single blob would turn every change into a
 * read-modify-write of the whole keymap. Fire-and-forget, mirroring
 * `putKeyboardAccess` — the store already holds the value, and the DEFAULTS
 * push reconciles anything that lands out of order.
 */
export function putKeymapOverride(commandId: string, json: string): void {
  const url = `/api/defaults/dev.tugtool.keymap/${encodeURIComponent(commandId)}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: json }),
  }).catch((err) => {
    console.warn("[settings] PUT keymap override failed for", commandId, err);
  });
}

/**
 * Read the app-test setup-suppression flag from the TugbankClient cache.
 * Seeded by tugcast at startup when the app-test harness marker is present
 * (before the server accepts connections, so it is readable at deck mount):
 * `true` keeps the blocking ConfigureTug wizard closed so focus/selection-driven
 * tests never race it; a ConfigureTug-specific test opts back in through the
 * harness, which seeds `false`. Stored under `dev.tugtool.app` /
 * `suppress-setup` (Value::Bool); absent on normal launches.
 */
export function readSetupSuppressed(client: TugbankClient): boolean {
  const entry = client.get("dev.tugtool.app", "suppress-setup");
  return entry?.kind === "bool" && entry.value === true;
}

/**
 * Persist the first-launch flag to tugbank under `dev.tugtool.app` /
 * `setup-seen`. Fire-and-forget, mirroring `putTheme`.
 */
export function putSetupSeen(seen: boolean): void {
  fetch("/api/defaults/dev.tugtool.app/setup-seen", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "bool", value: seen }),
  }).catch((err) => {
    console.warn("[settings] PUT setup-seen failed:", err);
  });
}

/** tugbank domain/key holding the app-wide default project directory. */
export const DEFAULT_PROJECT_PATH_DOMAIN = "dev.tugtool.app";
export const DEFAULT_PROJECT_PATH_KEY = "default-project-path";

/** Leaf directory name appended to the home directory when nothing is set. */
export const DEFAULT_PROJECT_DIR_LEAF = "tug";

/**
 * Read the **explicit** default project directory — the path the user chose in
 * ConfigureTug or Settings ▸ General — or null when the key was never written.
 *
 * Explicit and resolved are different values and callers must pick
 * deliberately. The session picker's seed chain uses the explicit value, so an
 * unset key falls through to the Swift `initial-project-path` launch hint
 * rather than being shadowed by a computed `~/tug`. Everything that needs a
 * directory to actually operate on — Open Quickly's fallback root, the setup
 * step's prefill — uses {@link resolveDefaultProjectPath}.
 *
 * Stored under `dev.tugtool.app` / `default-project-path` (Value::String).
 */
export function readDefaultProjectPath(client: TugbankClient): string | null {
  const entry = client.get(
    DEFAULT_PROJECT_PATH_DOMAIN,
    DEFAULT_PROJECT_PATH_KEY,
  );
  if (entry && entry.kind === "string" && typeof entry.value === "string") {
    return entry.value;
  }
  return null;
}

/**
 * Persist the default project directory to tugbank under `dev.tugtool.app` /
 * `default-project-path`, and resolve with the value that is now stored — the
 * canonical spelling of `path`, `""` when the setting was cleared, or **null**
 * when nothing was stored at all.
 *
 * Awaited, not fire-and-forget, and the local cache is written only after the
 * server has taken the value. This setting is displayed back to the user by
 * the field that sets it and by Open Quickly's search bar, so a write that
 * silently didn't land would leave both of them naming a directory Tug is not
 * using. The caller shows what this resolves with, never what it asked for.
 *
 * The path is canonicalized through the server gateway first ([L29]): it is a
 * persisted key, compared against project bindings and recent projects to
 * decide whether two entries name one directory, so it may not be stored in
 * whatever spelling the user happened to type. A path the gateway won't
 * resolve is not stored — a refusal, reported as null.
 */
export async function putDefaultProjectPath(
  path: string,
): Promise<string | null> {
  const canonical = path === "" ? "" : await canonicalizeDirPath(path);
  if (canonical === null) {
    tugDevLogStore.warn("settings", "default-project-path not canonical", {
      path,
    });
    return null;
  }
  try {
    const response = await fetch(
      `/api/defaults/${DEFAULT_PROJECT_PATH_DOMAIN}/${DEFAULT_PROJECT_PATH_KEY}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "string", value: canonical }),
      },
    );
    if (!response.ok) {
      tugDevLogStore.warn("settings", "PUT default-project-path rejected", {
        status: response.status,
      });
      return null;
    }
  } catch (err) {
    tugDevLogStore.warn("settings", "PUT default-project-path failed", {
      error: String(err),
    });
    return null;
  }
  // Reflect it locally now that the server holds it: the local cache is what
  // `readDefaultProjectPath` reads, and the server's DEFAULTS frame comes back
  // around a beat later. Without this an Open Quickly opened in the same breath
  // as the commit searches the directory the user just stopped using.
  getTugbankClient()?.setLocalValue(
    DEFAULT_PROJECT_PATH_DOMAIN,
    DEFAULT_PROJECT_PATH_KEY,
    { kind: "string", value: canonical },
  );
  return canonical;
}

/**
 * Resolve the default project directory: the explicit value when set, else
 * `<home>/tug`. Returns null only when nothing is set and the host's home
 * directory is not yet known (host facts still in flight) — callers defer.
 *
 * The computed `<home>/tug` is never written back to tugbank; it stays a
 * read-side fallback so users who will never re-run setup get the feature
 * without a migration, and so the explicit tier stays meaningfully empty.
 */
export function resolveDefaultProjectPath(
  client: TugbankClient,
  home: string | null,
): string | null {
  return resolveProjectPathFrom(readDefaultProjectPath(client), home);
}

/**
 * The same resolution, over an explicit value the caller already has, for a
 * React caller that subscribes to the setting rather than reading the cache
 * ([L02] — the subscribed read is the only one that re-renders on a change).
 * One fallback rule, two ways in.
 */
export function resolveProjectPathFrom(
  explicit: string | null,
  home: string | null,
): string | null {
  if (explicit !== null && explicit !== "") return explicit;
  if (home === null || home === "") return null;
  return `${home.replace(/\/+$/, "")}/${DEFAULT_PROJECT_DIR_LEAF}`;
}

/**
 * PUT a single per-card state bag to tugbank under `dev.tugtool.deck.cardstate/{cardId}`.
 *
 * Resolves `true` when tugbank accepted the write and `false` when it failed
 * or answered non-2xx — on both the synchronous XHR branch and the fetch
 * branch. The result is the only evidence a card's typed state actually
 * reached disk: tugbank can be mid-restart at quit time, and an unreported
 * failure there is silent data loss ([L23]).
 */
export function putCardState(cardId: string, bag: CardStateBag, options?: { keepalive?: boolean; sync?: boolean }): Promise<boolean> {
  const url = `/api/defaults/${CARDSTATE_DOMAIN}/${encodeURIComponent(cardId)}`;
  // Durable copy only — an over-cap cellHeights seed is dropped so the
  // store stays bounded; the in-memory cache keeps the full bag.
  const body = JSON.stringify({ kind: "json", value: capDurableCardState(bag) });

  if (options?.sync) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url, false);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(body);
      if (xhr.status < 200 || xhr.status >= 300) {
        tugDevLogStore.warn("settings", "PUT cardState (sync) rejected", {
          cardId,
          status: xhr.status,
        });
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    } catch (err) {
      tugDevLogStore.warn("settings", "PUT cardState (sync) failed", {
        cardId,
        error: String(err),
      });
      return Promise.resolve(false);
    }
  }

  return fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: options?.keepalive,
  })
    .then((response) => {
      if (!response.ok) {
        tugDevLogStore.warn("settings", "PUT cardState rejected", {
          cardId,
          status: response.status,
        });
        return false;
      }
      return true;
    })
    .catch((err) => {
      tugDevLogStore.warn("settings", "PUT cardState failed", {
        cardId,
        error: String(err),
      });
      return false;
    });
}

/**
 * Card-keyed defaults domains — one entry per card id, written as a card
 * gains state and never removed by the close path. All accumulate the same
 * way, so all get the same orphan sweep at startup.
 */
export const CARD_KEYED_DOMAINS: readonly string[] = [
  CARDSTATE_DOMAIN,
  PERMISSION_MODE_DOMAIN,
  MODEL_DOMAIN,
  PLAN_REVIEW_LAST_DOMAIN,
  // The per-card view settings, one domain per card kind. They accumulate
  // exactly like the others — a card that was tuned once and closed leaves
  // its blob behind — so they belong in the same sweep.
  TEXT_CARD_DOMAIN,
  IMAGE_CARD_DOMAIN,
  PDF_CARD_DOMAIN,
];

/** DELETE a single defaults entry from tugbank. Fire-and-forget. */
export function deleteDefault(domain: string, key: string): Promise<void> {
  const url = `/api/defaults/${domain}/${encodeURIComponent(key)}`;
  return fetch(url, { method: "DELETE" })
    .then(() => {})
    .catch((err) => {
      console.warn("[settings] DELETE failed for", domain, key, err);
    });
}

/**
 * Delete durable per-card defaults for cards no longer present in the deck.
 * Run once at startup after the deck mounts: a card's close path flushes its
 * last bag / permission mode / model to tugbank but never removes them, so
 * without this sweep each {@link CARD_KEYED_DOMAINS} domain grows unbounded
 * across the app's life — the leak that bloated the store to 18 MB and
 * stalled the boot-time DEFAULTS frame. Reads each domain's keys from the
 * (already-populated) TugbankClient cache and DELETEs any card id not live.
 * Fire-and-forget; a failed delete just lingers until the next boot.
 */
export function pruneOrphanedCardDefaults(
  client: TugbankClient,
  liveCardIds: Set<string>,
): void {
  for (const domain of CARD_KEYED_DOMAINS) {
    const entries = client.readDomain(domain);
    if (entries === undefined) continue;
    for (const cardId of Object.keys(entries)) {
      if (!liveCardIds.has(cardId)) {
        void deleteDefault(domain, cardId);
      }
    }
  }
}

/**
 * Session-keyed durable domains ([P07]): the `/btw` history and the
 * staged-context queue survive an app relaunch keyed by `tug_session_id`
 * (preserved across relaunch by the F1 fresh-spawn fix). The values are small
 * JSON blobs (capped per session), read from the TugbankClient cache at store
 * construction. Entries for evicted sessions age with the ledger — a future
 * sweep can prune them by live session id, mirroring `pruneOrphanedCardDefaults`.
 */
export const SIDE_QUESTIONS_DOMAIN = "dev.tugtool.side-questions";
export const PENDING_CONTEXT_DOMAIN = "dev.tugtool.pending-context";

/** PUT a session's `/btw` history to tugbank (fire-and-forget). */
export function putSideQuestionHistory(sessionId: string, history: unknown): void {
  const url = `/api/defaults/${SIDE_QUESTIONS_DOMAIN}/${encodeURIComponent(sessionId)}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "json", value: history }),
  })
    .then(() => {})
    .catch((err) => {
      console.warn("[settings] PUT side-questions failed for", sessionId, err);
    });
}

/** PUT a session's staged-context queue + VISIBILITY to tugbank (fire-and-forget). */
export function putPendingContext(sessionId: string, state: unknown): void {
  const url = `/api/defaults/${PENDING_CONTEXT_DOMAIN}/${encodeURIComponent(sessionId)}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "json", value: state }),
  })
    .then(() => {})
    .catch((err) => {
      console.warn("[settings] PUT pending-context failed for", sessionId, err);
    });
}

/**
 * PUT the focused card ID to tugbank (fire-and-forget).
 */
export function putFocusedCardId(focusedCardId: string): void {
  fetch("/api/defaults/dev.tugtool.deck.state/focusedCardId", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: focusedCardId }),
  }).catch((err) => {
    console.warn("[settings] PUT focusedCardId failed:", err);
  });
}

// ── Editor settings ─────────────────────────────────────────────────────────

/** Editor settings shape stored in tugbank. */
export interface EditorSettings {
  fontId: string;
  fontSize: number;
  /** Whether the editor wraps long lines. Defaults to false on the
   *  substrate; opt-in via the editor settings sheet. */
  lineWrap: boolean;
  /** Whether the editor renders the line-numbers gutter. */
  lineNumbers: boolean;
  /** Whether the editor highlights the gutter cell of the line containing
   *  the cursor. Independent of `lineNumbers`. */
  highlightActiveLineGutter: boolean;
  /** Main Return-key submit policy. `"newline"` (default) → Return
   *  inserts a newline, Shift+Return submits; `"submit"` → the inverse. */
  returnKeyAction: "submit" | "newline";
  /** Numpad-Enter submit policy, independent of the Return key.
   *  `"submit"` (default) → Enter submits, Shift+Enter inserts a newline;
   *  `"newline"` → the inverse. */
  numpadEnterAction: "submit" | "newline";
}

/**
 * Read editor settings from the TugbankClient cache.
 */
export function readEditorSettings(client: TugbankClient): EditorSettings | null {
  const entry = client.get("dev.tugtool.editor", "settings");
  if (entry && entry.kind === "json" && entry.value !== undefined) {
    return entry.value as EditorSettings;
  }
  return null;
}

/**
 * PUT editor settings to tugbank (fire-and-forget).
 */
export function putEditorSettings(settings: EditorSettings): void {
  fetch("/api/defaults/dev.tugtool.editor/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "json", value: settings }),
  }).catch((err) => {
    console.warn("[settings] PUT editorSettings failed:", err);
  });
}

/**
 * GET editor settings from tugbank (HTTP, for use without TugbankClient).
 */
export async function getEditorSettings(): Promise<EditorSettings | null> {
  try {
    const response = await fetch("/api/defaults/dev.tugtool.editor/settings");
    if (response.status === 404) return null;
    const tagged = await response.json() as { kind: string; value: unknown };
    if (tagged.kind === "json" && tagged.value !== undefined) {
      return tagged.value as EditorSettings;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Text Card defaults ─────────────────────────────────────────────────────

/**
 * Read the deck-wide Text Card defaults from the TugbankClient cache.
 * The raw blob is narrowed by `parseTextCardSettings`; this just
 * fetches the tagged value's `value` (or null when unset).
 */
export function readTextCardDefaults(client: TugbankClient): unknown {
  const entry = client.get("dev.tugtool.text-card", "settings");
  if (entry && entry.kind === "json" && entry.value !== undefined) {
    return entry.value;
  }
  return null;
}

/**
 * PUT the deck-wide defaults for one card kind (fire-and-forget). A newly
 * opened card of that kind adopts these when it has nothing of its own; see
 * `use-card-settings.ts`.
 */
export function putCardSettingsDefaults(
  domain: string,
  key: string,
  defaults: unknown,
): void {
  const url = `/api/defaults/${domain}/${encodeURIComponent(key)}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "json", value: defaults }),
  }).catch((err) => {
    console.warn(`[settings] PUT card defaults failed for ${domain}:`, err);
  });
}

/**
 * PUT one card's per-card view settings to tugbank (fire-and-forget), keyed
 * by cardId under that kind's domain.
 */
export function putCardSettings(
  domain: string,
  cardId: string,
  settings: unknown,
): void {
  const url = `/api/defaults/${domain}/${encodeURIComponent(cardId)}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "json", value: settings }),
  }).catch((err) => {
    console.warn(`[settings] PUT card settings failed for ${cardId}:`, err);
  });
}

/** PUT the deck-wide Text Card defaults. */
export function putTextCardDefaults(defaults: unknown): void {
  putCardSettingsDefaults("dev.tugtool.text-card", "settings", defaults);
}

/** PUT one Text card's per-card editor settings. */
export function putTextCardCardSettings(cardId: string, settings: unknown): void {
  putCardSettings(TEXT_CARD_DOMAIN, cardId, settings);
}

// ── Transcript settings ─────────────────────────────────────────────────────

/**
 * Transcript-settings shape stored in tugbank. Presentation knobs for
 * the Session card's transcript pane (top pane, distinct from the editor
 * pane below it):
 *
 *   - `magnification`: the Settings sheet's Magnification slider value
 *     (1 = 100%). Implemented as CSS `zoom` on the transcript root —
 *     it scales the whole transcript subtree (text, code, atoms, icons)
 *     uniformly via layout zoom, scoped to this card's transcript and
 *     leaving the surrounding chrome at 1×. Distinct from the macOS
 *     host's `WKWebView.pageZoom` (View > Zoom In / Out), which scales
 *     the entire window; the two compose.
 */
export interface TranscriptSettings {
  magnification: number;
}

/**
 * PUT transcript settings to tugbank (fire-and-forget).
 */
export function putTranscriptSettings(settings: TranscriptSettings): void {
  fetch("/api/defaults/dev.tugtool.transcript/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "json", value: settings }),
  }).catch((err) => {
    console.warn("[settings] PUT transcriptSettings failed:", err);
  });
}

// ── Default permission mode ─────────────────────────────────────────────────

/**
 * PUT the global default permission mode to tugbank (fire-and-forget). The
 * value is a bare mode string (e.g. `"plan"`) under
 * `dev.tugtool.permission-mode/default`. New cards adopt it on mount; see
 * `resolveSeedPermissionMode` and `use-permission-mode.ts`.
 */
export function putDefaultPermissionMode(mode: string): void {
  fetch("/api/defaults/dev.tugtool.permission-mode/default", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: mode }),
  }).catch((err) => {
    console.warn("[settings] PUT defaultPermissionMode failed:", err);
  });
}

// ── Default effort ──────────────────────────────────────────────────────────

/**
 * PUT the global default effort level to tugbank (fire-and-forget). The value
 * is a bare level string (e.g. `"high"`) under `dev.tugtool.effort/default`.
 * New cards adopt it on mount; see `resolveSeedEffort` and `use-effort.ts`.
 */
export function putDefaultEffort(level: string): void {
  fetch("/api/defaults/dev.tugtool.effort/default", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: level }),
  }).catch((err) => {
    console.warn("[settings] PUT defaultEffort failed:", err);
  });
}

// ── Live model catalog ──────────────────────────────────────────────────────

/**
 * PUT the live model catalog to tugbank (fire-and-forget). The value is the
 * `session_capabilities.models` array claude reported on its most recent
 * `initialize` handshake, under `dev.tugtool.models/catalog`. This is the
 * always-current source the picker fallback and the Settings default dropdown
 * read so a resumed / session-less / just-launched card never shows a stale
 * hand-maintained list. See `model-catalog.ts`.
 */
export function putModelCatalog(models: unknown): void {
  fetch("/api/defaults/dev.tugtool.models/catalog", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "json", value: models }),
  }).catch((err) => {
    console.warn("[settings] PUT modelCatalog failed:", err);
  });
}

// ── Default model ───────────────────────────────────────────────────────────

/**
 * PUT the global default model selector to tugbank (fire-and-forget). The value
 * is a bare selector string (`"default"` / `"sonnet"` / `"haiku"`) under
 * `dev.tugtool.model/default`. New cards adopt it on mount; see
 * `resolveSeedModel` and `use-model.ts`. `"default"` means the account default
 * (no forced model).
 */
export function putDefaultModel(selector: string): void {
  fetch("/api/defaults/dev.tugtool.model/default", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: selector }),
  }).catch((err) => {
    console.warn("[settings] PUT defaultModel failed:", err);
  });
}

// ── Find options ────────────────────────────────────────────────────────────

/**
 * Read the deck-wide Find option toggles (Case sensitive / Entire word / Grep)
 * from the TugbankClient cache. Stored under `dev.tugtool.find` / `options`
 * (Value::Json). Returns null when unset or malformed, so a fresh session falls
 * back to `DEFAULT_FIND_OPTIONS`. The three fields are validated individually —
 * a partial or corrupted blob (e.g. a future renamed key) contributes only the
 * booleans it actually carries, defaulting the rest to `false`.
 */
export function readFindOptions(client: TugbankClient): FindOptions | null {
  const entry = client.get("dev.tugtool.find", "options");
  if (!entry || entry.kind !== "json" || entry.value === undefined) {
    return null;
  }
  const raw = entry.value as Partial<Record<keyof FindOptions, unknown>> | null;
  if (!raw || typeof raw !== "object") return null;
  return {
    caseSensitive: raw.caseSensitive === true,
    wholeWord: raw.wholeWord === true,
    grep: raw.grep === true,
  };
}

/**
 * PUT the deck-wide Find option toggles to tugbank (fire-and-forget). New Find
 * sessions adopt these on construction (see `session-card`'s `findSession` seed) so
 * a toggle survives a card reload.
 */
export function putFindOptions(options: FindOptions): void {
  fetch("/api/defaults/dev.tugtool.find/options", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "json", value: options }),
  }).catch((err) => {
    console.warn("[settings] PUT findOptions failed:", err);
  });
}

// ── Split pane layouts ──────────────────────────────────────────────────────

/**
 * Split-pane layout persisted in tugbank.
 *
 * - `layout`: panel id → flex-grow value, mirroring react-resizable-panels'
 *   `Layout` type. This is the relative-size dimension; restored as the
 *   library's `defaultLayout`.
 * - `pixels`: panel id → pixel size, for panels that opted into
 *   `groupResizeBehavior="preserve-pixel-size"`. Captured at every
 *   `onLayoutChanged` (drags and library-driven container resizes).
 *   Restored imperatively via `panel.resize("Npx")` after first measure
 *   so pixel-pinned panes keep their size across cards, reloads, and
 *   different container sizes — independent of the flex-grow ratio.
 *
 * The legacy on-disk shape was a bare `Record<string, number>` (the old
 * `layout` map). `readSplitPaneLayout` accepts either shape; the writer
 * always emits the new shape.
 */
export interface SplitPaneLayout {
  layout: Record<string, number>;
  pixels?: Record<string, number>;
}

/**
 * Legacy on-disk shape (bare flex-grow map). Read path lifts this into
 * the new `SplitPaneLayout` shape transparently.
 */
type SplitPaneLayoutLegacy = Record<string, number>;

function isLegacyLayoutShape(value: unknown): value is SplitPaneLayoutLegacy {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  // New shape always has a `layout` object; legacy shape stores numbers
  // directly under panel ids.
  if ("layout" in obj && typeof obj.layout === "object") return false;
  for (const v of Object.values(obj)) {
    if (typeof v !== "number") return false;
  }
  return true;
}

// Cache lifted shapes so identical raw entries (same TugbankClient cache
// reference) produce the same lifted reference. `useSyncExternalStore`
// requires stable snapshots — without this, a legacy record would lift
// to a fresh object every read and loop the subscriber.
const liftedSplitPaneLayoutCache: WeakMap<object, SplitPaneLayout> = new WeakMap();

/**
 * Read a split-pane layout from the TugbankClient cache.
 *
 * Domain: `dev.tugtool.tugways.split-pane`, key: caller-provided `storageKey`.
 * Returns the layout object, or null if not stored. Lifts the legacy
 * bare-record shape into `{ layout: <record> }` and caches the lift so
 * repeated reads return the same reference.
 */
export function readSplitPaneLayout(
  client: TugbankClient,
  storageKey: string,
): SplitPaneLayout | null {
  const entry = client.get("dev.tugtool.tugways.split-pane", storageKey);
  if (!entry || entry.kind !== "json" || entry.value === undefined) {
    return null;
  }
  const raw = entry.value as object;
  const cached = liftedSplitPaneLayoutCache.get(raw);
  if (cached) return cached;
  const lifted: SplitPaneLayout = isLegacyLayoutShape(raw)
    ? { layout: raw }
    : (raw as SplitPaneLayout);
  liftedSplitPaneLayoutCache.set(raw, lifted);
  return lifted;
}

/**
 * PUT a split-pane layout to tugbank (fire-and-forget).
 *
 * Domain: `dev.tugtool.tugways.split-pane`, key: caller-provided `storageKey`.
 *
 * `keepalive: true` lets the request outlive the page. Callers fire this
 * on sash pointerup, and users frequently reload immediately after
 * dragging; without `keepalive`, the reload cancels the in-flight PUT
 * before it reaches the server and the drag is silently lost.
 */
export function putSplitPaneLayout(storageKey: string, layout: SplitPaneLayout): void {
  const url = `/api/defaults/dev.tugtool.tugways.split-pane/${encodeURIComponent(storageKey)}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "json", value: layout }),
    keepalive: true,
  }).catch((err) => {
    console.warn("[settings] PUT splitPaneLayout failed for key", storageKey, err);
  });
}

// ── Dev recent projects ────────────────────────────────────────────────────

/** Maximum number of recent-project paths retained in the quick-pick list. */
export const SESSION_RECENT_PROJECTS_MAX = 5;

/**
 * Read the session-card recent-projects list from the TugbankClient cache.
 *
 * Domain: `dev.tugtool.dev`, key: `recent-projects`.
 * Value shape: `{ paths: string[] }`. Returns `[]` if unset or malformed.
 *
 * The list is keyed by the user-typed project path — the same identifier
 * the picker displays, submits on `spawn_session`, and uses to key the
 * `session-id-by-workspace` map. Session bookkeeping uses a single
 * identifier so every consumer (recents, session-id map, bind
 * payload, tugcode's persistence) reads and writes the same string.
 */
export function readSessionRecentProjects(client: TugbankClient): string[] {
  const entry = client.get("dev.tugtool.dev", "recent-projects");
  if (!entry || entry.kind !== "json" || entry.value === undefined) {
    return [];
  }
  const raw = entry.value as { paths?: unknown } | null;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.paths)) {
    return [];
  }
  return raw.paths.filter((p): p is string => typeof p === "string" && p.length > 0);
}

/**
 * PUT the session-card recent-projects list to tugbank (fire-and-forget).
 * Callers are responsible for dedup + capping; the helper writes the list
 * verbatim.
 */
export function putSessionRecentProjects(paths: string[]): void {
  fetch("/api/defaults/dev.tugtool.dev/recent-projects", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "json", value: { paths } }),
  }).catch((err) => {
    console.warn("[settings] PUT recent-projects failed:", err);
  });
}

/**
 * Prepend `projectDir` onto `existing`, dedup case-sensitively, and cap at
 * `SESSION_RECENT_PROJECTS_MAX`. Pure helper so callers can compose the new
 * list before handing it to `putSessionRecentProjects`.
 */
export function insertSessionRecentProject(existing: string[], projectDir: string): string[] {
  const next = [projectDir, ...existing.filter((p) => p !== projectDir)];
  return next.slice(0, SESSION_RECENT_PROJECTS_MAX);
}
