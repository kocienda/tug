/**
 * banner-base — what `TugBanner` and `TugPaneBanner` share.
 *
 * The two banners differ in scope — one blocks the deck, the other one card,
 * portalled into it — and so in how they mount and what they make inert. What
 * they share is the props a banner is described by and the dwell gate that
 * keeps a banner on screen long enough to read: once shown, a close is held
 * until `minMountedMs` has passed since the banner first painted, and once a
 * close is committed it runs to completion, so an ordered-out banner cannot be
 * revived mid-exit.
 *
 * Laws: [L06] the gate moves no React state of its own — it holds refs and
 * schedules the caller's exit; [L19] internal module, no `data-slot`.
 *
 * @module components/tugways/internal/banner-base
 */

import React from "react";

/** The props both banners are described by. */
export interface TugBannerBaseProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "role"> {
  /** Whether the banner is open (shown). @selector [data-visible="true"] | [data-visible="false"] */
  open: boolean;
  /** Banner kind: its layout. @selector [data-kind="status"] | [data-kind="error"] */
  kind?: "status" | "error";
  /** Visual severity. @selector [data-tone="danger"] | [data-tone="caution"] | [data-tone="default"] @default "danger" */
  tone?: "danger" | "caution" | "default";
  /** Optional leading icon for the strip, e.g. `<WifiOff />`; sized to 16px. */
  icon?: React.ReactNode;
  /** Detail panel body content (error kind). */
  children?: React.ReactNode;
  /**
   * Footer content. In the error kind it pins to the bottom of the detail
   * panel while `children` scrolls above it; typically the primary action.
   */
  footer?: React.ReactNode;
  /**
   * Disables the `inert` blocking — for gallery demos that show the banner
   * inside a preview without blocking the app. The banner still draws.
   * @default false
   */
  contained?: boolean;
  /**
   * Floor on how long a shown banner stays, in milliseconds. A close that
   * arrives sooner is held until the floor, then the exit runs; once a close
   * is committed, a re-open is ignored until the exit completes. `0` opts out.
   * @default 500
   */
  minMountedMs?: number;
  /**
   * Clock injection for tests. Defaults to `performance.now`. Production code
   * never sets this.
   * @internal
   */
  nowMs?: () => number;
}

/** The dwell gate a banner drives from its show and exit effects. */
export interface BannerDwell {
  /** True from a committed close until {@link BannerDwell.reset}. */
  committed(): boolean;
  /** Records the first paint of shown content; later calls keep the first. */
  markShown(): void;
  /**
   * Commits to closing and runs `exit` once the floor allows: at once when
   * the floor has passed or no paint was recorded, otherwise after the rest
   * of it. Commitment is binding until {@link BannerDwell.reset}.
   */
  commitExit(exit: () => void): void;
  /** Clears the gate when an exit completes, so the next show starts clean. */
  reset(): void;
}

/**
 * The dwell gate. The pending timer is cleared on unmount — the exit effects
 * deliberately return no cleanup, so a re-render mid-hold keeps the schedule.
 */
export function useBannerDwell(minMountedMs: number, nowMs?: () => number): BannerDwell {
  const nowRef = React.useRef<() => number>(nowMs ?? (() => performance.now()));
  nowRef.current = nowMs ?? (() => performance.now());
  const minRef = React.useRef(minMountedMs);
  minRef.current = minMountedMs;

  const shownAtRef = React.useRef<number | null>(null);
  const committedRef = React.useRef(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // useLayoutEffect so the clear lands in the unmount commit itself.
  React.useLayoutEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  return React.useMemo<BannerDwell>(
    () => ({
      committed: () => committedRef.current,
      markShown: () => {
        if (shownAtRef.current === null) shownAtRef.current = nowRef.current();
      },
      commitExit: (exit) => {
        committedRef.current = true;
        const run = (): void => {
          timerRef.current = null;
          exit();
        };
        // No recorded paint means no dwell to honour: close now rather than
        // hold the whole floor over a banner nobody saw.
        const shownAt = shownAtRef.current;
        const remaining =
          shownAt === null ? 0 : Math.max(0, minRef.current - (nowRef.current() - shownAt));
        if (remaining > 0) {
          timerRef.current = setTimeout(run, remaining);
          return;
        }
        run();
      },
      reset: () => {
        shownAtRef.current = null;
        committedRef.current = false;
        timerRef.current = null;
      },
    }),
    [],
  );
}
