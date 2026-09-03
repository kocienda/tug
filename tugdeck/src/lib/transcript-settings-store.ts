/**
 * TranscriptSettingsStore — subscribable store for the Session card
 * transcript's presentation knobs.
 *
 * One setting:
 *
 *   - `magnification` (factor, 1 = 100%): the Settings sheet's
 *     Magnification slider, implemented as CSS `zoom` applied to the
 *     transcript root via `--transcript-zoom`. Layout zoom scopes the
 *     scale to this card's transcript subtree (which wholly contains
 *     the list scrollport, so the list's measurements stay in one
 *     uniformly-scaled space), leaving the surrounding chrome at 1×.
 *     Distinct from — and composes with — the Swift host's
 *     `WKWebView.pageZoom` (View > Zoom In / Out), which scales the
 *     whole window.
 *
 * The store applies it as a CSS custom property on the bound transcript
 * root, so the transcript pane reads exactly the user's choice and no
 * other markdown surface in the deck is affected.
 *
 * Reads initial state synchronously from the TugbankClient cache
 * (no async load, no placeholder flash). Observes `onDomainChanged`
 * for live updates from external processes.
 *
 * **Laws:** [L02] useSyncExternalStore-compatible subscribe/getSnapshot.
 * [L06] Appearance via CSS custom properties, not React state.
 * [L22] Store changes drive DOM directly, not through React render.
 * [L23] Synchronous initial read — no visible state disturbance.
 *
 * @module lib/transcript-settings-store
 */

import { getTugbankClient } from "./tugbank-singleton";
import { putTranscriptSettings } from "@/settings-api";
import type { TranscriptSettings } from "@/settings-api";

// ── Constants ───────────────────────────────────────────────────────────────

const DOMAIN = "dev.tugapp.transcript";
const KEY = "settings";

export const DEFAULT_TRANSCRIPT_SETTINGS: TranscriptSettings = {
  magnification: 1,
};

// ── Store ───────────────────────────────────────────────────────────────────

export class TranscriptSettingsStore {
  private _settings: TranscriptSettings;
  private _listeners: Set<() => void> = new Set();
  private _targetEl: HTMLElement | null = null;
  private _unsubscribeTugbank: (() => void) | null = null;

  constructor() {
    this._settings = this._readFromCache() ?? { ...DEFAULT_TRANSCRIPT_SETTINGS };

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
   *  Persisted snapshots may carry retired fields; we pick out the keys we
   *  still consume and ignore the rest, so the next write doesn't perpetuate
   *  the stale shape. */
  private _readFromCache(): TranscriptSettings | null {
    const client = getTugbankClient();
    if (!client) return null;
    const entry = client.get(DOMAIN, KEY);
    if (entry && entry.kind === "json" && entry.value !== undefined) {
      const raw = entry.value as Partial<TranscriptSettings>;
      return {
        ...DEFAULT_TRANSCRIPT_SETTINGS,
        ...(typeof raw.magnification === "number" ? { magnification: raw.magnification } : {}),
      };
    }
    return null;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Bind the transcript root element for CSS custom property updates. */
  bind(el: HTMLElement): void {
    this._targetEl = el;
    this._applyCSSProperties();
  }

  /** Unbind the DOM element (e.g., on unmount). */
  unbind(): void {
    this._targetEl = null;
  }

  /** Get the current settings snapshot. (L02 — useSyncExternalStore) */
  getSnapshot = (): TranscriptSettings => {
    return this._settings;
  };

  /** Subscribe to settings changes. Returns unsubscribe. (L02) */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  /** Update one or more settings. Applies immediately and persists. */
  set(partial: Partial<TranscriptSettings>): void {
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
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private _applySettings(next: TranscriptSettings, persist: boolean): void {
    this._settings = next;

    this._applyCSSProperties();

    for (const listener of this._listeners) listener();

    if (persist) putTranscriptSettings(next);
  }

  private _applyCSSProperties(): void {
    const el = this._targetEl;
    if (!el) return;
    el.style.setProperty("--transcript-zoom", `${this._settings.magnification}`);
  }
}
