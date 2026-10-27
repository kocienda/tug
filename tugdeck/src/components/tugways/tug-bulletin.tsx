/**
 * TugBulletin — Non-blocking notification system.
 *
 * Wraps Sonner for toast lifecycle management. Fire-and-forget imperative API
 * via the bulletin() function. TugBulletinProvider mounts once in the root tree,
 * wrapping its children and providing context for useTugBulletin().
 * Sonner owns enter/exit animations — CSS handles styling only [L14].
 *
 * **Where the stack is drawn.** Wherever the host makes body views, every
 * card stands over the shell's page, so a bulletin the shell drew there was
 * covered by whatever card stood under it — a sidebar rail most of all,
 * since the stack sits at the top-right corner a right rail fills ([B08]).
 * There the shell installs a relay ({@link setBulletinRelay}) and every
 * deck bulletin is shown in the overlay page above the cards instead
 * (`overlay.bulletin`); the overlay's own provider shows it with
 * {@link showBulletinHere}. Only text crosses, so an `action` callback is
 * dropped there with a warning. Where the host keeps no overlay — a plain
 * browser — the shell's own provider shows it, as before.
 *
 * **The stack evades the rails.** Either page's stack stands clear of any
 * sidebar rail on its side: the deck canvas publishes each side's rail span
 * ({@link setBulletinInsets}) and the Toaster's offset adds it to Sonner's
 * own 24px through a custom property on the provider's host element, so a
 * rail appearing, closing or changing width moves the stack with no render
 * ([L06]).
 *
 * Laws: [L06] appearance via CSS, [L16] pairings declared, [L19] component authoring guide
 */

import "./tug-bulletin.css";

import React, { createContext, useContext } from "react";
import { Toaster, toast } from "sonner";

import { BULLETIN_ICONS } from "./bulletin-icons";
import { tugDevLogStore } from "../../lib/tug-dev-log-store/tug-dev-log-store";

/* ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------*/

type SonnerPosition =
  | "top-right"
  | "top-left"
  | "bottom-right"
  | "bottom-left"
  | "top-center"
  | "bottom-center";

function mapPosition(position: TugBulletinProviderProps["position"]): SonnerPosition {
  switch (position) {
    case "top-left":     return "top-left";
    case "bottom-right": return "bottom-right";
    case "bottom-left":  return "bottom-left";
    case "top-right":
    default:             return "top-right";
  }
}

function mapOptions(options?: BulletinOptions): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (options?.description !== undefined) result.description = options.description;
  if (options?.sticky === true) {
    // Persist-until-dismissed: never auto-dismiss, and render an OK button
    // (left-aligned on its own row, like any bulletin action). Sonner
    // dismisses the toast itself when its action is clicked, so the handler
    // is a no-op.
    result.duration = Infinity;
    result.action = { label: options.okLabel ?? "OK", onClick: () => {} };
  } else {
    if (options?.duration !== undefined) result.duration = options.duration;
    if (options?.action !== undefined) {
      result.action = {
        label: options.action.label,
        onClick: options.action.onClick,
      };
    }
  }
  return result;
}

/* ---------------------------------------------------------------------------
 * TugBulletinProviderProps
 * ---------------------------------------------------------------------------*/

export interface TugBulletinProviderProps {
  /** Position of the bulletin stack. @default "top-right" */
  position?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  /** Child components that need access to useTugBulletin(). */
  children?: React.ReactNode;
}

/* ---------------------------------------------------------------------------
 * TugBulletinContext + TugBulletinProvider + useTugBulletin
 * ---------------------------------------------------------------------------*/

/** Shape of the context value provided by TugBulletinProvider. */
interface TugBulletinContextValue {
  bulletin: typeof bulletin;
}

const TugBulletinContext = createContext<TugBulletinContextValue | null>(null);

/**
 * TugBulletinProvider — mounts once in the root render tree, wrapping children.
 *
 * Wraps Sonner's <Toaster> and provides TugBulletinContext so descendant
 * components can call useTugBulletin() to get the bulletin function.
 * All visual styling is handled by tug-bulletin.css via the `tug-bulletin`
 * className applied in toastOptions.
 */
export function TugBulletinProvider({ position = "top-right", children }: TugBulletinProviderProps) {
  const contextValue = React.useMemo(() => ({ bulletin }), []);

  return React.createElement(
    TugBulletinContext.Provider,
    { value: contextValue },
    children,
    React.createElement(
      "div",
      { className: "tug-bulletin-host", ref: registerBulletinHost },
      React.createElement(Toaster, {
        position: mapPosition(position),
        toastOptions: {
          className: "tug-bulletin",
          unstyled: true,
        },
        // Every bulletin carries a close affordance — dismissal never waits on
        // the auto-dismiss timeout.
        closeButton: true,
        icons: BULLETIN_ICONS,
        gap: 8,
        offset: BULLETIN_OFFSET,
      }),
    ),
  );
}

/* ---------------------------------------------------------------------------
 * Rail insets — the stack stands clear of the sidebar rails
 * ---------------------------------------------------------------------------*/

/** How far each side's sidebar rail reaches in from the window edge, layout
 *  px, or 0 where no rail stands. */
export interface BulletinInsets {
  left: number;
  right: number;
}

/** Sonner's own viewport offset, which every side keeps. */
const BULLETIN_EDGE_PX = 24;

const INSET_LEFT_PROPERTY = "--tug-bulletin-inset-left";
const INSET_RIGHT_PROPERTY = "--tug-bulletin-inset-right";

/** Sonner writes these onto its toaster as `--offset-*`; the side ones read
 *  the rail insets the host element carries, so the stack moves with the
 *  rails through the DOM alone ([L06]). */
const BULLETIN_OFFSET = {
  top: BULLETIN_EDGE_PX,
  bottom: BULLETIN_EDGE_PX,
  left: `calc(${BULLETIN_EDGE_PX}px + var(${INSET_LEFT_PROPERTY}, 0px))`,
  right: `calc(${BULLETIN_EDGE_PX}px + var(${INSET_RIGHT_PROPERTY}, 0px))`,
};

let bulletinInsets: BulletinInsets = { left: 0, right: 0 };
const bulletinHosts = new Set<HTMLElement>();

function writeInsets(el: HTMLElement): void {
  el.style.setProperty(INSET_LEFT_PROPERTY, `${bulletinInsets.left}px`);
  el.style.setProperty(INSET_RIGHT_PROPERTY, `${bulletinInsets.right}px`);
}

/** The provider's host element, registered at mount and given the standing
 *  insets at once, so a stack mounted after the rails were laid out is
 *  already clear of them. */
function registerBulletinHost(el: HTMLDivElement | null): void {
  if (el === null) {
    for (const host of bulletinHosts) if (!host.isConnected) bulletinHosts.delete(host);
    return;
  }
  bulletinHosts.add(el);
  writeInsets(el);
}

/**
 * Publish how far each side's rail reaches in, so every mounted stack —
 * and any mounted later — stands clear of it. Written only when a value
 * changes.
 */
export function setBulletinInsets(insets: BulletinInsets): void {
  if (insets.left === bulletinInsets.left && insets.right === bulletinInsets.right) return;
  bulletinInsets = { left: insets.left, right: insets.right };
  for (const host of bulletinHosts) writeInsets(host);
}

/** The insets last published, for tests. */
export function getBulletinInsets(): BulletinInsets {
  return bulletinInsets;
}

/**
 * useTugBulletin — returns the bulletin function for fire-and-forget notifications.
 *
 * Must be used inside a TugBulletinProvider.
 *
 * @example
 * ```tsx
 * const showBulletin = useTugBulletin();
 * showBulletin("Card saved successfully");
 * showBulletin.success("Export complete", { description: "3 cards exported." });
 * ```
 */
export function useTugBulletin(): typeof bulletin {
  const ctx = useContext(TugBulletinContext);
  if (!ctx) {
    throw new Error("useTugBulletin must be used within a TugBulletinProvider");
  }
  return ctx.bulletin;
}

/* ---------------------------------------------------------------------------
 * BulletinOptions
 * ---------------------------------------------------------------------------*/

export interface BulletinOptions {
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
  /**
   * Persist until the user dismisses it (no auto-dismiss), showing an OK
   * button on its own row. Use for outcomes the user should acknowledge
   * rather than glance at. Composes with any tone helper. Overrides
   * `duration` / `action`.
   */
  sticky?: boolean;
  /**
   * Label for the sticky dismiss button.
   * @default "OK"
   */
  okLabel?: string;
}

/* ---------------------------------------------------------------------------
 * bulletin() — imperative fire-and-forget API
 * ---------------------------------------------------------------------------*/

/**
 * bulletin() — fire-and-forget non-blocking notification.
 *
 * Maps to Sonner's toast() API. Use bulletin.success(), bulletin.danger(),
 * and bulletin.caution() for tone variants.
 *
 * @example
 * ```ts
 * bulletin("Card saved successfully");
 * bulletin.success("Export complete", { description: "3 cards exported." });
 * bulletin.danger("Upload failed", { action: { label: "Retry", onClick: handleRetry } });
 * ```
 */
export function bulletin(message: string, options?: BulletinOptions): void {
  raise("default", message, options);
}

bulletin.success = (message: string, options?: BulletinOptions): void => {
  raise("success", message, options);
};

bulletin.danger = (message: string, options?: BulletinOptions): void => {
  raise("danger", message, options);
};

bulletin.caution = (message: string, options?: BulletinOptions): void => {
  raise("caution", message, options);
};

/* ---------------------------------------------------------------------------
 * The relay — a deck bulletin shown in the overlay page
 * ---------------------------------------------------------------------------*/

export type BulletinTone = "default" | "success" | "danger" | "caution";

/** A deck bulletin as it crosses to the overlay page: text only. */
export interface RelayedBulletin {
  tone: BulletinTone;
  message: string;
  description?: string;
  duration?: number;
  sticky?: boolean;
  okLabel?: string;
}

let bulletinRelay: ((relayed: RelayedBulletin) => void) | null = null;

/**
 * Send every deck bulletin to `relay` instead of this page's stack, or show
 * them here again with `null`. The shell installs one wherever the host
 * keeps an overlay above the cards (`lib/overlay-shell.ts`).
 */
export function setBulletinRelay(relay: ((relayed: RelayedBulletin) => void) | null): void {
  bulletinRelay = relay;
}

/** What `options` becomes when it crosses: the text and the timing, never
 *  a callback. A sticky bulletin's OK button is drawn by the far side. */
export function relayedBulletinOf(
  tone: BulletinTone,
  message: string,
  options?: BulletinOptions,
): RelayedBulletin {
  const relayed: RelayedBulletin = { tone, message };
  if (options?.description !== undefined) relayed.description = options.description;
  if (options?.duration !== undefined && Number.isFinite(options.duration)) relayed.duration = options.duration;
  if (options?.sticky === true) relayed.sticky = true;
  if (options?.okLabel !== undefined) relayed.okLabel = options.okLabel;
  return relayed;
}

function raise(tone: BulletinTone, message: string, options?: BulletinOptions): void {
  if (bulletinRelay === null) {
    showWithSonner(tone, message, mapOptions(options));
    return;
  }
  if (options?.action !== undefined && options.sticky !== true) {
    tugDevLogStore.warn("bulletin", "a deck bulletin's action cannot cross to the overlay; shown without it");
  }
  bulletinRelay(relayedBulletinOf(tone, message, options));
}

/** Show a relayed bulletin in this page's stack — the overlay's answer to
 *  `overlay.bulletin`. Never relays again. */
export function showBulletinHere(relayed: RelayedBulletin): void {
  showWithSonner(
    relayed.tone,
    relayed.message,
    mapOptions({
      description: relayed.description,
      duration: relayed.duration,
      sticky: relayed.sticky,
      okLabel: relayed.okLabel,
    }),
  );
}

function showWithSonner(tone: BulletinTone, message: string, options: Record<string, unknown>): void {
  switch (tone) {
    case "success": toast.success(message, options); return;
    case "danger":  toast.error(message, options); return;
    case "caution": toast.warning(message, options); return;
    default:        toast(message, options); return;
  }
}
