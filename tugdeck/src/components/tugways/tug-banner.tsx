/**
 * TugBanner — app-modal state barrier for system conditions.
 *
 * Two variants: "status" (compact horizontal strip, always mounted, visibility
 * driven by the `visible` prop) and "error" (strip at top + centered detail panel,
 * conditionally rendered by ErrorBoundary as its fallback UI). No user action can
 * dismiss it — the `visible` prop or React unmount controls presence.
 *
 * Status variant: scrim + `inert` on the deck canvas sibling block interaction
 * while visible. Exit animation plays, then `inert` is removed. Error variant:
 * composes TugPushButton for the reload action [L20] — button keeps its own tokens.
 *
 * Both variants share a .tug-banner-strip element that renders as a bold, full-width,
 * solid-color attention strip. The error variant adds a .tug-banner-detail-panel
 * below the strip for the stack trace and reload action.
 *
 * Laws: [L06] appearance via CSS, [L16] pairings declared, [L19] component authoring guide,
 *       [L20] token sovereignty (error variant composes TugPushButton)
 */

import "./tug-banner.css";

import React from "react";
import { sizedIcon } from "./internal/sized-icon";
import { cn } from "@/lib/utils";
import { animate } from "@/components/tugways/tug-animator";
import { useBannerDwell, type TugBannerBaseProps } from "./internal/banner-base";

/* ---------------------------------------------------------------------------
 * TugBanner
 * ---------------------------------------------------------------------------*/

/**
 * Props for {@link TugBanner}: the shared banner props, with `kind`
 * defaulting to `"status"`. The dwell floor has no effect on the error kind,
 * which ErrorBoundary renders as terminal fallback UI and never toggles.
 */
export interface TugBannerProps extends TugBannerBaseProps {
  /** Banner heading/message text */
  message: string;
}

export const TugBanner = React.forwardRef<HTMLDivElement, TugBannerProps>(
  function TugBanner(
    {
      open,
      kind = "status",
      tone = "danger",
      message,
      icon,
      children,
      footer,
      contained = false,
      minMountedMs = 500,
      nowMs,
      className,
      ...rest
    },
    ref,
  ) {
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const scrimRef = React.useRef<HTMLDivElement | null>(null);
    const hasBeenVisibleRef = React.useRef(false);

    // The shared dwell gate (status kind only): a close is held until the
    // floor has passed since the slide-in, and a committed close is binding.
    const dwell = useBannerDwell(minMountedMs, nowMs);

    // Tracks the canvas element we currently hold an `inert` attribute
    // on, so the unmount-only cleanup below knows what to release.
    // Setting and clearing happen inline in the animation effect; the
    // ref + unmount-cleanup pattern avoids the previous design's
    // problem of re-run cleanups stripping inert mid-deferral.
    const inertOwnerRef = React.useRef<HTMLElement | null>(null);

    // Unmount-only safety net: if the component is destroyed while the
    // banner still owns an inert attribute on the canvas (e.g., torn
    // down mid-deferral or mid-exit-animation), release it so the
    // attribute doesn't leak past the component's lifetime. Empty
    // deps ensure this cleanup runs only once, on unmount.
    //
    // useLayoutEffect (not useEffect) so the inert release happens
    // synchronously with the unmount commit — same paint as the
    // banner disappearing. With useEffect, the inert clear would land
    // a frame after the banner is gone, leaving the canvas briefly
    // non-interactive even though there's nothing on top of it.
    React.useLayoutEffect(() => {
      return () => {
        if (inertOwnerRef.current) {
          inertOwnerRef.current.removeAttribute("inert");
          inertOwnerRef.current = null;
        }
      };
    }, []);

    // Combine forwarded ref with our internal ref
    const setRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        rootRef.current = node;
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }
      },
      [ref],
    );

    // Animation + gate for status variant.
    // Animation always runs (including contained gallery demos).
    // Inert is only managed when NOT contained (real banner, not gallery).
    // Inert tracking lives on `inertOwnerRef`; the unmount-only effect
    // above releases it if the component is torn down while still
    // holding the attribute. This effect does NOT use cleanup to
    // release inert or clear the deferral timer — that pattern would
    // strip state mid-deferral when the parent re-asserts visible.
    //
    // Min-mount-time gate: if the banner has been visible for less than
    // `minMountedMs`, the slide-out is deferred until the floor is
    // reached. The deferral is binding — once committed, the exit runs
    // to completion regardless of subsequent visible toggles. Re-runs
    // while committed are no-ops.
    React.useLayoutEffect(() => {
      if (kind !== "status") return;

      // Already committed: the deferral or in-flight slide-out owns
      // the rest of this cycle. No-op until finishExit resets the gate.
      if (dwell.committed()) return;

      const root = rootRef.current;
      if (!root) return;

      const scrimEl = scrimRef.current;

      // Find deck canvas for inert management (null when contained — that's fine).
      let canvas: HTMLElement | null = null;
      if (!contained) {
        const parent = root.parentElement;
        if (parent) {
          canvas = parent.querySelector<HTMLElement>("[data-slot=\"deck-canvas\"]");
        }
      }

      if (open) {
        hasBeenVisibleRef.current = true;

        // Record the slide-in start; dependency-only re-runs (kind or
        // contained changing under a stable open) keep the first.
        dwell.markShown();

        // Set inert immediately — banner blocks interaction as it enters.
        // Tracked via inertOwnerRef so the unmount-only effect can
        // release it if the component is destroyed before the slide-out
        // completes.
        if (canvas) {
          canvas.setAttribute("inert", "");
          inertOwnerRef.current = canvas;
        }

        animate(root, [{ transform: "translateY(-100%)" }, { transform: "translateY(0)" }], {
          key: "banner-root",
          duration: "--tug-motion-duration-moderate",
          easing: "ease-out",
        });
        if (scrimEl) {
          animate(scrimEl, [{ opacity: 0 }, { opacity: 1 }], {
            key: "banner-scrim",
            duration: "--tug-motion-duration-moderate",
          });
        }
        return;
      }

      if (!hasBeenVisibleRef.current) return;

      const finishExit = () => {
        // Release inert AFTER the slide-out animation finishes —
        // visual and interaction stay in sync. Reset gate refs so a
        // fresh visible: true starts a clean cycle.
        if (inertOwnerRef.current) {
          inertOwnerRef.current.removeAttribute("inert");
          inertOwnerRef.current = null;
        }
        dwell.reset();
      };

      const runSlideOut = () => {
        // Only run exit animation if the banner was previously shown.
        // Skipping on initial mount prevents a flash: the exit animation starts
        // from translateY(0) which would briefly show the banner before hiding it.
        const exitAnim = animate(root, [{ transform: "translateY(0)" }, { transform: "translateY(-100%)" }], {
          key: "banner-root",
          duration: "--tug-motion-duration-moderate",
          easing: "ease-in",
        });
        if (scrimEl) {
          animate(scrimEl, [{ opacity: 1 }, { opacity: 0 }], {
            key: "banner-scrim",
            duration: "--tug-motion-duration-moderate",
          });
        }
        exitAnim.finished.then(finishExit).catch(finishExit);
      };

      // First close after a shown cycle: commit to exit. The guard at the
      // top makes later re-runs no-ops; the hold is binding.
      dwell.commitExit(runSlideOut);
    }, [open, kind, contained, dwell]);

    // Error variant: strip at top + detail panel centered below.
    // Conditionally rendered — always shown as visible, no exit animation.
    if (kind === "error") {
      return (
        <div
          ref={setRef}
          data-slot="tug-banner"
          className={cn("tug-banner", className)}
          {...rest}
          data-kind="error"
          data-visible="true"
          data-tone={tone}
          data-contained={contained ? "true" : undefined}
          role="alert"
          aria-live="assertive"
        >
          {/* Strip — full-width, solid, high-urgency */}
          <div className="tug-banner-strip">
            <span className="tug-banner-message">{message}</span>
          </div>
          {/* Detail panel — centered, constrained, scrollable diagnostic
              area with an optional pinned footer that stays fixed while
              the body scrolls. */}
          <div className="tug-banner-detail-panel">
            <div className="tug-banner-detail-body">{children}</div>
            {footer !== undefined && (
              <div className="tug-banner-detail-footer">{footer}</div>
            )}
          </div>
        </div>
      );
    }

    // Status variant: always mounted, visibility controlled by data-visible.
    return (
      <>
        {/* Scrim — always rendered for status variant (contained only skips inert, not scrim) */}
        <div
          ref={scrimRef}
          className="tug-banner-scrim"
          data-open={String(open)}
          data-contained={contained ? "true" : undefined}
          aria-hidden="true"
        />
        <div
          ref={setRef}
          data-slot="tug-banner"
          className={cn("tug-banner", className)}
          {...rest}
          data-kind="status"
          data-visible={String(open)}
          data-tone={tone}
          role="status"
          aria-live="polite"
        >
          {/* Strip — full-width, solid, bold attention strip */}
          <div className="tug-banner-strip">
            {icon && (
              <span className="tug-banner-icon" aria-hidden="true">
                {sizedIcon(icon, 16)}
              </span>
            )}
            <span className="tug-banner-message">{message}</span>
          </div>
        </div>
      </>
    );
  },
);
