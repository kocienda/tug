/**
 * EditorSettingsStore — subscribable store for editor font/size/spacing settings.
 *
 * Reads initial state synchronously from the TugbankClient cache (no async
 * load, no placeholder flash). Observes `onDomainChanged` for live updates
 * from external processes.
 *
 * On change, the store:
 *   1. Notifies subscribers (for useSyncExternalStore — popup labels).
 *   2. Applies CSS custom properties to the bound DOM element (L06, L22).
 *   3. Updates the atom font and regenerates atom images.
 *   4. Persists to tugbank (fire-and-forget).
 *
 * **Laws:** [L02] useSyncExternalStore-compatible subscribe/getSnapshot.
 * [L06] Appearance via CSS custom properties, not React state.
 * [L22] Store changes drive DOM directly, not through React render.
 * [L23] Synchronous initial read — no visible state disturbance.
 *
 * @module lib/editor-settings-store
 */

import { getTugbankClient } from "./tugbank-singleton";
import { putEditorSettings } from "@/settings-api";
import type { EditorSettings } from "@/settings-api";
import { editorLineHeightFor, setAtomFont } from "./tug-atom-img";

// ── Constants ───────────────────────────────────────────────────────────────

const DOMAIN = "dev.tugapp.editor";
const KEY = "settings";

/**
 * Editor line metrics are no longer user-tunable — they're pinned so atom
 * chips can be sized to fit the line box without a moving target. The
 * line-height constant lives in `tug-atom-img` (the chip bake sizes editor
 * chips from it; defining it there avoids an import cycle) and is re-exported
 * here for the store's consumers. The store publishes these as
 * `--tug-line-height-editor` / `--tug-letter-spacing-editor` on the bound
 * element.
 */
export { editorLineHeightFor } from "./tug-atom-img";
export const EDITOR_LETTER_SPACING = "normal";

export const DEFAULT_SETTINGS: EditorSettings = {
  fontId: "plex-mono",
  fontSize: 13,
  lineWrap: true,
  lineNumbers: false,
  highlightActiveLineGutter: false,
  // Return inserts a newline (prompts are long-form); Shift+Return
  // submits. Numpad Enter submits. Both overridable in the settings sheet.
  returnKeyAction: "newline",
  numpadEnterAction: "submit",
};

/** Font stacks keyed by font ID. */
export const FONT_STACKS: Record<string, string> = {
  "plex-sans": '"IBM Plex Sans", "Segoe UI", system-ui, -apple-system, sans-serif',
  "plex-mono": '"IBM Plex Mono", "SFMono-Regular", "Menlo", monospace',
};

/** Default font size per font (mono reads larger than proportional). */
export const FONT_DEFAULT_SIZES: Record<string, number> = {
  "plex-sans": 14,
  "plex-mono": 13,
};

// ── Store ───────────────────────────────────────────────────────────────────

export class EditorSettingsStore {
  private _settings: EditorSettings;
  private _listeners: Set<() => void> = new Set();
  private _targetEl: HTMLElement | null = null;
  private _regenerateAtoms: (() => void) | null = null;
  private _unsubscribeTugbank: (() => void) | null = null;

  constructor() {
    // Synchronous read from TugbankClient cache (populated before any
    // React rendering occurs). Falls back to defaults if not yet stored.
    this._settings = this._readFromCache() ?? { ...DEFAULT_SETTINGS };

    // Seed the atom-font module state synchronously, BEFORE any React
    // chip render. Without this seed, the first React render of a
    // transcript / tool-block chip would bake with the
    // atom-img module's default `_measureFamily` (system-ui, sans-serif)
    // and stick with that until something triggers a re-render. The
    // editor's `bind()` later calls the same _applyAtomFont and busts
    // CM6's widget cache via `_regenerateAtoms`, but React-side chips
    // only refresh on subscription notify; getting the seed right at
    // construction eliminates the cold-boot race entirely.
    //
    // The `_regenerateAtoms?.()` chain inside `_applyAtomFont` is a
    // no-op here (no callback bound yet); `bind()` re-applies later
    // and that pass actually triggers the editor's regenerate.
    this._applyAtomFont();

    // Observe live changes from external processes.
    const client = getTugbankClient();
    if (client) {
      this._unsubscribeTugbank = client.onDomainChanged((domain) => {
        if (domain !== DOMAIN) return;
        const fresh = this._readFromCache();
        if (fresh) this._applySettings(fresh, false);
      });
    }
  }

  /** Read settings from the TugbankClient cache. Returns null if not stored.
   *  Picks only the current schema fields so retired keys (the old
   *  user-tunable `lineHeight` / `letterSpacing`) are dropped rather than
   *  round-tripped back into tugbank; missing keys fall back to defaults. */
  private _readFromCache(): EditorSettings | null {
    const client = getTugbankClient();
    if (!client) return null;
    const entry = client.get(DOMAIN, KEY);
    if (entry && entry.kind === "json" && entry.value !== undefined) {
      const stored = entry.value as Partial<EditorSettings>;
      return {
        fontId: stored.fontId ?? DEFAULT_SETTINGS.fontId,
        fontSize: stored.fontSize ?? DEFAULT_SETTINGS.fontSize,
        lineWrap: stored.lineWrap ?? DEFAULT_SETTINGS.lineWrap,
        lineNumbers: stored.lineNumbers ?? DEFAULT_SETTINGS.lineNumbers,
        highlightActiveLineGutter:
          stored.highlightActiveLineGutter ?? DEFAULT_SETTINGS.highlightActiveLineGutter,
        returnKeyAction: stored.returnKeyAction ?? DEFAULT_SETTINGS.returnKeyAction,
        numpadEnterAction: stored.numpadEnterAction ?? DEFAULT_SETTINGS.numpadEnterAction,
      };
    }
    return null;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Bind a DOM element for CSS custom property updates, and an atom regenerator. */
  bind(el: HTMLElement, regenerateAtoms: () => void): void {
    this._targetEl = el;
    this._regenerateAtoms = regenerateAtoms;
    // Apply current settings to the newly bound element immediately.
    this._applyCSSProperties();
    this._applyAtomFont();
  }

  /** Unbind the DOM element (e.g., on unmount). */
  unbind(): void {
    this._targetEl = null;
    this._regenerateAtoms = null;
  }

  /** Get the current settings snapshot. (L02 — useSyncExternalStore) */
  getSnapshot = (): EditorSettings => {
    return this._settings;
  };

  /** Subscribe to settings changes. Returns unsubscribe. (L02) */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  /** Update a single setting. Applies immediately and persists. */
  set(partial: Partial<EditorSettings>): void {
    // When changing font, auto-set the default size for that font.
    if (partial.fontId && partial.fontSize === undefined) {
      partial.fontSize = FONT_DEFAULT_SIZES[partial.fontId] ?? 13;
    }
    const next = { ...this._settings, ...partial };
    this._applySettings(next, true);
  }

  /** Dispose subscriptions. */
  dispose(): void {
    if (this._unsubscribeTugbank) {
      this._unsubscribeTugbank();
      this._unsubscribeTugbank = null;
    }
    this._listeners.clear();
    this._targetEl = null;
    this._regenerateAtoms = null;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private _applySettings(next: EditorSettings, persist: boolean): void {
    // Validate fontId.
    if (!FONT_STACKS[next.fontId]) next.fontId = DEFAULT_SETTINGS.fontId;

    this._settings = next;

    // CSS custom properties (L06 — appearance via DOM, not React state).
    this._applyCSSProperties();

    // Atom font (Canvas measurement + SVG rendering).
    this._applyAtomFont();

    // Notify useSyncExternalStore subscribers (popup button labels).
    for (const listener of this._listeners) listener();

    // Persist to tugbank (fire-and-forget).
    if (persist) putEditorSettings(next);
  }

  private _applyCSSProperties(): void {
    const el = this._targetEl;
    if (!el) return;
    const { fontId, fontSize } = this._settings;
    const stack = FONT_STACKS[fontId];
    if (stack) el.style.setProperty("--tug-font-family-editor", stack);
    el.style.setProperty("--tug-font-size-editor", `${fontSize}px`);
    // Letter spacing is fixed; the leading is derived, because an editor line
    // has to be able to seat an atom and the atom's height is its register's.
    el.style.setProperty("--tug-letter-spacing-editor", EDITOR_LETTER_SPACING);
    el.style.setProperty(
      "--tug-line-height-editor",
      String(editorLineHeightFor(fontSize)),
    );
  }

  private _applyAtomFont(): void {
    const { fontId, fontSize } = this._settings;
    const stack = FONT_STACKS[fontId];
    if (stack) setAtomFont(stack);
    this._regenerateAtoms?.();
    // The chip bake measures and paints its label with the document's
    // Canvas — a face that hasn't finished loading silently falls back
    // and the bounds come out wrong. Load the stack explicitly and
    // re-bake once it lands; in the steady state (main.tsx warms the
    // stacks at boot) the faces are already loaded, the promise
    // resolves immediately, and the regenerate is a no-op rebuild.
    if (stack && typeof document !== "undefined" && document.fonts) {
      document.fonts
        .load(`${fontSize}px ${stack}`)
        .then(() => this._regenerateAtoms?.())
        .catch(() => undefined);
    }
  }
}
