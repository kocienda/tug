/**
 * `sidebarWidthStore` — the width a sidebar card REOPENS at, per card.
 *
 * A sidebar card's live width is deck geometry: it lives in the layout blob as
 * the pane's `size.width`, and the space allocator flexes it. This is the other
 * number — the width the user last chose by hand, which a card that has been
 * closed and reopened comes back at ([L23]). Closing a rail must not be a way
 * to lose the size you gave it.
 *
 * Keyed by componentId, on that card's own tugbank domain
 * (`dev.tugtool.<componentId>`, key `widthPx`) — never Web storage.
 *
 * Conformance: [L02] `useSyncExternalStore`-compatible `subscribe` +
 * `getSnapshot`, and the snapshot reference is stable while nothing changes.
 *
 * @module lib/sidebar-width-store
 */

import { getTugbankClient } from "./tugbank-singleton";
import type { TaggedValue } from "./tugbank-client";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

/** The key each sidebar card's reopen width lives under, within its own
 *  domain. */
const WIDTH_KEY = "widthPx";

/** The tugbank domain owning `componentId`'s preferences. */
function domainFor(componentId: string): string {
  return `dev.tugtool.${componentId}`;
}

class SidebarWidthStore {
  private _widths: Readonly<Record<string, number>> = {};
  private readonly _listeners = new Set<() => void>();
  private readonly _hydrated = new Set<string>();
  private _tugbankUnsub: (() => void) | null = null;

  /**
   * Hydrate `componentId`'s width from tugbank once, and keep it live against
   * external writes. Called from every read, so a card that is never opened
   * costs nothing.
   */
  private _ensure(componentId: string): void {
    if (this._hydrated.has(componentId)) return;
    const client = getTugbankClient();
    if (!client) return;
    this._hydrated.add(componentId);
    this._hydrate(componentId);
    this._tugbankUnsub ??= client.onDomainChanged((domain) => {
      for (const id of this._hydrated) {
        if (domain === domainFor(id)) this._hydrate(id);
      }
    });
  }

  private _hydrate(componentId: string): void {
    const client = getTugbankClient();
    if (!client) return;
    const entry = client.get(domainFor(componentId), WIDTH_KEY);
    const width =
      entry !== undefined &&
      (entry.kind === "i64" || entry.kind === "f64") &&
      typeof entry.value === "number" &&
      Number.isFinite(entry.value)
        ? entry.value
        : undefined;
    if (width === undefined || this._widths[componentId] === width) return;
    this._widths = { ...this._widths, [componentId]: width };
    this._notify();
  }

  private _notify(): void {
    for (const listener of this._listeners) {
      try {
        listener();
      } catch (err) {
        console.warn("[SidebarWidthStore] listener error:", err);
      }
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): Readonly<Record<string, number>> => this._widths;

  /** The width `componentId` reopens at, or `undefined` when the user has
   *  never sized it — the caller's registration preferred width stands. */
  widthFor = (componentId: string): number | undefined => {
    this._ensure(componentId);
    return this._widths[componentId];
  };

  /** Record the width the user just gave `componentId`. */
  setWidth = (componentId: string, widthPx: number): void => {
    if (!Number.isFinite(widthPx) || widthPx <= 0) return;
    const next = Math.round(widthPx);
    this._ensure(componentId);
    if (this._widths[componentId] === next) return;
    this._widths = { ...this._widths, [componentId]: next };
    this._notify();
    this._persist(componentId, next);
  };

  private _persist(componentId: string, widthPx: number): void {
    const domain = domainFor(componentId);
    const body = { kind: "i64", value: widthPx };
    const client = getTugbankClient();
    if (client && typeof client.setLocalValue === "function") {
      client.setLocalValue(domain, WIDTH_KEY, body as TaggedValue);
    }
    fetch(`/api/defaults/${domain}/${encodeURIComponent(WIDTH_KEY)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch((err) => {
      tugDevLogStore.warn("sidebar-width-store", `PUT ${domain} failed`, {
        error: String(err),
      });
    });
  }
}

export const sidebarWidthStore = new SidebarWidthStore();
