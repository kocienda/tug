/**
 * CardTitleStore — per-card title override surfaced in pane chrome.
 *
 * A card's registered `defaultMeta.title` is the static label baked
 * into the registry at card type definition time ("Dev", "Git",
 * "Hello"). Some cards have a stateful identity beyond their type —
 * the Session card binds to a project at session pick time, and from
 * that moment forward the title bar should reflect *which* project
 * is loaded, not just "Dev".
 *
 * This store is the sanctioned channel for that override. Cards
 * write `set(cardId, "<override>")` once their identity resolves
 * and `clear(cardId)` (or unmount) when it goes away. The pane
 * subscribes via `useSyncExternalStore` and composes the override
 * with the registry title as `"<registry> — <override>"`.
 *
 * ## The masthead sidecar
 *
 * A card may also ask for a taller chrome tier by publishing a
 * {@link CardMastheadPayload} beside its string. Which payload kind
 * it publishes decides where the displayed lines come from, and the
 * rule behind the split is one rule:
 *
 * **A fact that lives in a store travels as a key; a fact the card
 * itself holds travels as a value.** A session's lines come from
 * {@link useSessionIdentity} and move under a fixed identity, so
 * {@link SessionMastheadPayload} names the session and the chrome
 * resolves the rest — a snapshot would make this store a second
 * notification path for identity, and there is exactly one. A
 * document card's path and summary have no store behind them, so
 * {@link DocumentMastheadPayload} carries the strings and the card's
 * own `set()` call is the notification. A commit has no identity
 * store behind a sha either, so {@link CommitMastheadPayload} carries
 * its lines the same way.
 *
 * The string channel survives alongside it for **reader
 * compatibility**, not for notification: `get()` is what the tab bar,
 * the deck canvas, the Window menu, and the pane already consume.
 * Note what that means for a session card — its Line string is
 * `<project>/<callsign>`, and a callsign is immutable, so `set` is
 * effectively once per binding and nothing may be built on a re-`set`
 * firing.
 *
 * **Laws:**
 * - [L02] subscribable store, consumed via `useSyncExternalStore`
 *   (no `useEffect` copying through React state).
 * - [L09] / [L10] the pane (chrome) and the card (content) stay in
 *   their lanes; this store is the channel between them, not a
 *   prop drill or DOM query.
 * - [L24] structure-zone state shared across the pane / card
 *   boundary.
 *
 * @module lib/card-title-store
 */

/**
 * A Session card's request for the masthead tier, and the key the chrome
 * resolves its content from. Never a snapshot of what to display: session
 * identity lives in {@link useSessionIdentity} and its lines change under a
 * fixed key, so a snapshot here would be a second notification path for it.
 */
export interface SessionMastheadPayload {
  readonly kind: "session-masthead";
  readonly sessionId: string;
}

/**
 * A document card's request for the masthead tier, carrying the lines to
 * display.
 *
 * The strings travel here rather than behind a key because a document card's
 * masthead has no identity store standing behind it — a path, a dirty mark, a
 * diff's file count are facts the card already holds and already publishes
 * through this store's string channel. There is no second notification path
 * to create: the card's own `set()` call IS the notification, which is the
 * rule the session payload's key exists to protect.
 */
export interface DocumentMastheadPayload {
  readonly kind: "card-masthead";
  /** Lead line — the document's name. Truncates at the tail. */
  readonly title: string;
  /** Second line — where the document lives, or what it summarizes. */
  readonly description: string | null;
  /**
   * What the description IS, which decides how it clips: a `"path"` keeps its
   * tail (the filename) and sheds its head, anything else clips normally.
   */
  readonly descriptionKind?: "path" | "text";
  /**
   * Whether {@link description} is a fact STANDING IN for the place this card
   * would name if it had one — a draft that is not a file yet, a diff with no
   * repository behind it. Painted a step quieter by the tier, exactly as the
   * session masthead's own last rung is ([D132]).
   *
   * A card with nothing to name publishes a stand-in rather than `null`: the
   * tier is a fixed three lines, so a null description is not a shorter
   * masthead, it is a hole between two filled ones. Only the card knows which
   * rung it landed on, so only the card can say.
   */
  readonly descriptionStandIn?: boolean;
  /** Third line — quieter still, and optional; most cards stop at two. */
  readonly detail?: string | null;
  /** Lead-line glyph, resolved against the lucide `icons` map by the chrome. */
  readonly icon?: string;
}

/** One changed file on a commit masthead's record — the copy's roster row. */
export interface CommitMastheadFile {
  readonly path: string;
  readonly status: string;
  readonly added: number;
  readonly removed: number;
}

/**
 * A Commit card's request for the masthead tier, carrying the lines to
 * display, and the record its right-click menu states.
 *
 * A value payload rather than a key, for the document payload's reason: there
 * is no identity store standing behind a sha the way one stands behind a
 * session id, and the card's own publish on every snapshot change IS the
 * notification. Its own kind rather than a document payload because the lead
 * line is a PILL — `TugCommitAtom`, the mark every commit surface wears — and
 * the document payload's title is a string, which cannot carry one.
 *
 * The last three fields are not drawn. The tier claims the right-click for the
 * whole commit, and that menu's Copy Commit Record writes the message body,
 * the attribution and the changed-file roster — the same bytes the History
 * shade's row writes for the same commit. A payload carrying only the drawn
 * lines left the card, the one surface that shows a commit whole, copying the
 * least of it.
 */
export interface CommitMastheadPayload {
  readonly kind: "commit-masthead";
  /** Repository root the commit is read in — what its menu's Open Diff needs. */
  readonly root: string;
  /** The commit's sha. The pill abbreviates it for display. */
  readonly sha: string;
  /** Second line — the commit's subject. Empty until the record arrives. */
  readonly subject: string;
  /** Third line, with the date — the author's name. Empty until it arrives. */
  readonly author: string;
  /** Third line's stamp, strict ISO. Empty until the record arrives. */
  readonly dateIso: string;
  /** The message below the subject; what the menu's record copy states. */
  readonly body: string;
  /** The author's email, for the copied record's attribution line. */
  readonly authorEmail: string;
  /** The changed-file roster the copied record closes with. */
  readonly files: readonly CommitMastheadFile[];
}

/** A card's request for the masthead chrome tier. */
export type CardMastheadPayload =
  | SessionMastheadPayload
  | DocumentMastheadPayload
  | CommitMastheadPayload;

/**
 * Roster equality, by content. The card republishes on every snapshot change
 * and a store delivers more snapshots than it does distinct records, so a
 * reference comparison would notify on every one of them.
 */
function sameRoster(
  a: readonly CommitMastheadFile[],
  b: readonly CommitMastheadFile[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((file, i) => {
    const other = b[i];
    return (
      file.path === other.path &&
      file.status === other.status &&
      file.added === other.added &&
      file.removed === other.removed
    );
  });
}

/**
 * Payload equality, by kind. Guards the store's notify — see {@link
 * CardTitleStore.set}.
 */
function sameMasthead(
  a: CardMastheadPayload | undefined,
  b: CardMastheadPayload | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "session-masthead") {
    return a.sessionId === (b as SessionMastheadPayload).sessionId;
  }
  if (a.kind === "commit-masthead") {
    const commit = b as CommitMastheadPayload;
    return (
      a.root === commit.root &&
      a.sha === commit.sha &&
      a.subject === commit.subject &&
      a.author === commit.author &&
      a.dateIso === commit.dateIso &&
      a.body === commit.body &&
      a.authorEmail === commit.authorEmail &&
      sameRoster(a.files, commit.files)
    );
  }
  const other = b as DocumentMastheadPayload;
  return (
    a.title === other.title &&
    a.description === other.description &&
    (a.descriptionKind ?? "text") === (other.descriptionKind ?? "text") &&
    (a.descriptionStandIn ?? false) === (other.descriptionStandIn ?? false) &&
    (a.detail ?? null) === (other.detail ?? null) &&
    a.icon === other.icon
  );
}

class CardTitleStore {
  private readonly _overrides = new Map<string, string>();
  private readonly _mastheads = new Map<string, CardMastheadPayload>();
  private readonly _listeners = new Set<() => void>();

  /**
   * Set the title override for `cardId`, optionally with a masthead sidecar.
   * Idempotent.
   *
   * The equality guard compares the string **and** the payload. Comparing
   * only the string would drop a changed sidecar under an unchanged title —
   * and after the callsign became the whole string, an unchanged title is the
   * normal case, so the sidecar would arrive and notify nobody.
   */
  set(cardId: string, title: string, masthead?: CardMastheadPayload): void {
    const sameTitle = this._overrides.get(cardId) === title;
    const prev = this._mastheads.get(cardId);
    if (sameTitle && sameMasthead(prev, masthead)) return;
    this._overrides.set(cardId, title);
    if (masthead === undefined) this._mastheads.delete(cardId);
    else this._mastheads.set(cardId, masthead);
    this._notify();
  }

  /**
   * Set the masthead sidecar alone, leaving the title string as it is.
   *
   * For a card that wants the taller tier without renaming itself. A scoped
   * Diff pop-out is the case: its masthead says which file it is showing,
   * while its tab keeps the registry's "Diff" — the override REPLACES the
   * registry title, so publishing one would rename the tab too. Same
   * equality guard, so an unchanged payload notifies nobody.
   */
  setMasthead(cardId: string, masthead: CardMastheadPayload): void {
    if (sameMasthead(this._mastheads.get(cardId), masthead)) return;
    this._mastheads.set(cardId, masthead);
    this._notify();
  }

  /** Remove the title override (and any masthead) for `cardId`. */
  clear(cardId: string): void {
    if (!this._overrides.has(cardId) && !this._mastheads.has(cardId)) return;
    this._overrides.delete(cardId);
    this._mastheads.delete(cardId);
    this._notify();
  }

  /** Read the title override for `cardId`, or `null` when none. */
  get(cardId: string | null): string | null {
    if (cardId === null) return null;
    return this._overrides.get(cardId) ?? null;
  }

  /**
   * Read the masthead sidecar for `cardId`, or `null` when the card wants the
   * one-line bar. The returned object is stable while unchanged, so a pane may
   * snapshot it directly from `useSyncExternalStore`.
   */
  getMasthead(cardId: string | null): CardMastheadPayload | null {
    if (cardId === null) return null;
    return this._mastheads.get(cardId) ?? null;
  }

  /**
   * Monotonic revision, bumped on every change. A consumer that needs
   * *several* cards' overrides at once — the deck canvas, resolving the
   * titles of every pane in a slot's stack — has no single value to snapshot
   * and cannot call `get()` per card from `useSyncExternalStore` without
   * returning a fresh object each time. It subscribes to this instead and
   * reads the overrides it wants downstream of it, which keeps [L02] intact
   * with a snapshot that is stable by construction.
   */
  version = (): number => this._version;

  private _version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  private _notify(): void {
    // Bump BEFORE the listeners run: a `useSyncExternalStore` subscriber reads
    // the snapshot from inside its notification, and a revision incremented
    // afterwards would hand it the value it already had — the store would
    // notify and nothing would recompute.
    this._version += 1;
    for (const listener of this._listeners) listener();
  }
}

export const cardTitleStore = new CardTitleStore();
