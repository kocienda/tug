/**
 * TugPaneBulletin — pane-scoped, non-blocking notifications.
 *
 * The per-pane analog of the deck-global {@link bulletin} (`tug-bulletin.tsx`).
 * Both are thin wrappers over **Sonner** — there is no reason to re-implement
 * the stacking, hover-to-persist, swipe/close, and smooth enter/exit/reflow
 * that Sonner already does well. The only difference is *scope*: Sonner 2.x
 * routes a toast to a specific `<Toaster>` by id (a Toaster with an `id` shows
 * only toasts whose `toasterId` matches; the deck's id-less Toaster shows only
 * id-less toasts). So each `TugPaneBulletinProvider` mounts a `<Toaster>` with
 * a unique per-pane id and raises toasts addressed to it — and one card's
 * bulletins never appear over another's.
 *
 * The Toaster renders inline (Sonner does not portal) and positions itself with
 * container-relative offsets (`bottom`/`left`); `tug-pane-bulletin.css`
 * overrides Sonner's `position: fixed` to `absolute` within the provider's
 * relative, isolated root, which is what anchors the stack to the pane rather
 * than the viewport. Appearance is CSS-only via `unstyled` toasts ([L06]),
 * mirroring the deck bulletin.
 *
 * Laws: [L06] appearance via CSS/DOM, [L14] Sonner owns enter/exit animation,
 * [L19] component authoring.
 *
 * @module components/tugways/tug-pane-bulletin
 */

import "./tug-pane-bulletin.css";

import React, { createContext, useContext, useId, useMemo } from "react";
import { Toaster, toast } from "sonner";

import { BULLETIN_ICONS } from "./bulletin-icons";

/* ---------------------------------------------------------------------------
 * Options + imperative API
 * ---------------------------------------------------------------------------*/

/** Options for a pane bulletin — mirrors the deck `BulletinOptions`. */
export interface PaneBulletinOptions {
  /**
   * Stable id. A repeat call with the same id updates the existing bulletin
   * in place (text, tone, options) instead of stacking a second one, and
   * lets {@link TugPaneBulletinApi.dismiss} target it. Sonner keys toasts by
   * id; omit for fire-and-forget notices that need no later update.
   */
  id?: string;
  description?: string;
  /** Auto-dismiss delay in ms (Sonner default when omitted). */
  duration?: number;
  action?: { label: string; onClick: () => void };
  /**
   * Persist until the user dismisses it (no auto-dismiss), showing a
   * bottom-right dismiss button. Use for outcomes the user should
   * acknowledge rather than glance at. Composes with any tone helper
   * (`success`/`danger`/…). Overrides `duration` / `action`.
   */
  sticky?: boolean;
  /**
   * Label for the sticky dismiss button.
   * @default "OK"
   */
  okLabel?: string;
  /**
   * Called once the bulletin goes — closed by the user, or timed out. A
   * notice whose fact outlives the page that shows it (one the shell holds)
   * lets the fact go here, or the next page to mount speaks it again.
   */
  onGone?: () => void;
}

/**
 * Namespace a caller's logical bulletin id under its pane's `toasterId`.
 *
 * Sonner keys toasts by `id` in a single *global* store — `toasterId` only
 * routes which `<Toaster>` renders a toast, it does not scope identity. So two
 * panes raising the same logical id (e.g. every Session card's `"notice-api-retry"`)
 * collide: the second post updates — and steals — the first pane's toast. The
 * dismiss path (`toast.dismiss(id)`) is global for the same reason. Prefixing
 * the id with the per-pane `toasterId` (stable `useId`) gives each pane its own
 * id space while callers keep passing stable logical ids; the matching prefix
 * in `dismiss` keeps show/dismiss aligned.
 */
export function scopedToastId(toasterId: string, id: string): string {
  return `${toasterId}::${id}`;
}

/**
 * Pure mapping from `PaneBulletinOptions` to the Sonner `toast` options bag.
 * Exported for unit testing the option seam (id threading, sticky lifecycle)
 * without a mounted Toaster — the toast *behavior* is covered by app-tests.
 */
export function mapOptions(
  toasterId: string,
  options?: PaneBulletinOptions,
): Record<string, unknown> {
  const result: Record<string, unknown> = { toasterId };
  if (options?.id !== undefined)
    result.id = scopedToastId(toasterId, options.id);
  if (options?.description !== undefined) result.description = options.description;
  if (options?.onGone !== undefined) {
    const onGone = options.onGone;
    result.onDismiss = () => onGone();
    result.onAutoClose = () => onGone();
  }
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

/**
 * Fire-and-forget bulletin function returned by {@link useTugPaneBulletin},
 * with tone helpers — the pane-scoped sibling of the deck `bulletin()`.
 */
export interface TugPaneBulletinApi {
  (message: string, options?: PaneBulletinOptions): void;
  success: (message: string, options?: PaneBulletinOptions) => void;
  danger: (message: string, options?: PaneBulletinOptions) => void;
  caution: (message: string, options?: PaneBulletinOptions) => void;
  /** Dismiss a bulletin previously raised with `options.id`. */
  dismiss: (id: string) => void;
}

/** The per-pane Sonner toaster id, provided by {@link TugPaneBulletinProvider}. */
const PaneToasterIdContext = createContext<string | null>(null);

/* ---------------------------------------------------------------------------
 * Provider
 * ---------------------------------------------------------------------------*/

/**
 * Where the bulletin stack anchors within the pane. `"top"` / `"bottom"` are
 * the centered defaults; the four corners anchor a stack that should stay out
 * of the content's way (e.g. top-right for transient interruption notices).
 */
export type PaneBulletinPlacement =
  | "top"
  | "bottom"
  | "top-right"
  | "top-left"
  | "bottom-right"
  | "bottom-left";

export interface TugPaneBulletinProviderProps {
  /** Where the stack anchors within the pane. @default "bottom" */
  placement?: PaneBulletinPlacement;
  /** Merged onto the relative root (e.g. `flex: 1` sizing from a host card). */
  className?: string;
  /** Merged onto the relative root. */
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/**
 * Mounts a pane-scoped Sonner toaster around its children. The root is
 * `position: relative; isolation: isolate` so the toaster anchors to — and
 * stacks within — *this* pane. Pass `className` / `style` to size it (a card
 * body typically makes it fill the card).
 */
export function TugPaneBulletinProvider({
  placement = "bottom",
  className,
  style,
  children,
}: TugPaneBulletinProviderProps): React.ReactElement {
  // Stable, unique per provider instance — the Sonner toaster id that scopes
  // this pane's bulletins.
  const toasterId = useId();

  const rootClassName = className
    ? `tug-pane-bulletin-root ${className}`
    : "tug-pane-bulletin-root";

  return (
    <PaneToasterIdContext.Provider value={toasterId}>
      <div className={rootClassName} style={style}>
        {children}
        <Toaster
          id={toasterId}
          position={
            placement === "top"
              ? "top-center"
              : placement === "bottom"
                ? "bottom-center"
                : placement
          }
          toastOptions={{ className: "tug-pane-bulletin", unstyled: true }}
          // Every bulletin carries a close affordance — dismissal never waits
          // on the auto-dismiss timeout.
          closeButton
          icons={BULLETIN_ICONS}
          gap={8}
        />
      </div>
    </PaneToasterIdContext.Provider>
  );
}

/**
 * Returns the imperative bulletin function for the nearest
 * `TugPaneBulletinProvider`. Throws outside one.
 *
 * @example
 * ```tsx
 * const paneBulletin = useTugPaneBulletin();
 * paneBulletin("Most recent message copied");
 * paneBulletin.danger("Copy failed");
 * ```
 */
export function useTugPaneBulletin(): TugPaneBulletinApi {
  const toasterId = useContext(PaneToasterIdContext);
  if (toasterId === null) {
    throw new Error(
      "useTugPaneBulletin must be used within a TugPaneBulletinProvider",
    );
  }
  return useMemo(() => {
    const fn = ((message: string, options?: PaneBulletinOptions) => {
      toast(message, mapOptions(toasterId, options));
    }) as TugPaneBulletinApi;
    fn.success = (message, options) =>
      void toast.success(message, mapOptions(toasterId, options));
    fn.danger = (message, options) =>
      void toast.error(message, mapOptions(toasterId, options));
    fn.caution = (message, options) =>
      void toast.warning(message, mapOptions(toasterId, options));
    fn.dismiss = (id) => void toast.dismiss(scopedToastId(toasterId, id));
    return fn;
  }, [toasterId]);
}
