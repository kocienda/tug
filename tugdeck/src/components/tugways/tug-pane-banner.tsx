/**
 * TugPaneBanner — Card-scoped modal banner for card-level error / attention states.
 *
 * Combines TugBanner's visual language (strip at top + detail panel) with
 * TugSheet's scoping mechanics (portal into the card, `inert` on .tug-pane-body,
 * positioned below the title bar). Unlike TugBanner, TugPaneBanner does not
 * block the app — only the card it's mounted in. Other cards on the deck remain
 * fully interactive.
 *
 * Two variants:
 * - "error": strip (label + message) + centered detail panel (children) with
 *   pinned footer. The card body gets a dim backdrop so the detail panel reads
 *   as a modal overlay. `role="alert"` / `aria-live="assertive"`.
 * - "status": strip only, no detail panel, no backdrop. `role="status"` /
 *   `aria-live="polite"`.
 *
 * Both variants slide the strip down from the title-bar edge on enter and
 * reverse on exit; the error variant additionally fades the detail panel.
 * `inert` is applied to `.tug-pane-body` while the banner is mounted and
 * released only after the exit animation's `.finished` so interaction
 * returns in sync with the visuals.
 *
 * Lifecycle is self-managed (consumer drives `visible`). Animation uses
 * TugAnimator per L13; CSS keyframes are the wrong regime here because the
 * library doesn't own mount/unmount (L14).
 *
 * The banner itself is not a responder. Footer buttons are controls owned by
 * the consumer — dismiss is the consumer's responsibility per L11 (no
 * onDismiss callback prop). Pass a <TugPushButton> or equivalent in `footer`
 * whose onClick routes through the chain or updates local state.
 *
 * Laws: [L06] appearance via CSS/DOM,
 *       [L11] controls emit actions; responders handle them,
 *       [L13] TugAnimator for self-managed programmatic motion,
 *       [L14] no CSS keyframes for self-managed lifecycle,
 *       [L16] pairings declared,
 *       [L19] component authoring guide,
 *       [L20] token sovereignty (composes consumer-supplied footer controls)
 */

import "./tug-pane-banner.css";

import React, {
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import * as FocusScopeRadix from "@radix-ui/react-focus-scope";
import { icons } from "lucide-react";
import { cn } from "@/lib/utils";
import { TugPanePortalContext } from "@/components/chrome/tug-pane";
import { paneBodyOf } from "@/components/tugways/use-pane-inert";
import { CardIdContext } from "@/lib/card-id-context";
import { useBannerLifecycle } from "@/lib/banner-lifecycle";
import { group } from "@/components/tugways/tug-animator";

/* ---------------------------------------------------------------------------
 * Props
 * ---------------------------------------------------------------------------*/

export interface TugPaneBannerProps {
  /** Whether the banner is shown. @selector [data-visible="true"] | [data-visible="false"] */
  visible: boolean;
  /** Layout variant. @selector [data-variant="error"] | [data-variant="status"] @default "error" */
  variant?: "error" | "status";
  /** Visual severity. @selector [data-tone="danger"] | [data-tone="caution"] | [data-tone="default"] @default "danger" */
  tone?: "danger" | "caution" | "default";
  /** Short high-contrast strip label (e.g. "Connection lost"). Rendered bold, left of the message. */
  label?: string;
  /**
   * Strip message content. Usually a plain string; accepts any node so a
   * banner can embed a live element — e.g. a DOM-ticked countdown span
   * ([L22]) — inline in the message without round-tripping each tick
   * through React.
   */
  message: React.ReactNode;
  /** Optional Lucide icon name for the strip (most useful for status variant). */
  icon?: string;
  /**
   * Optional custom node rendered in place of the Lucide icon. When
   * provided, the strip uses this node and ignores `icon`. Use for
   * indicators that need their own animation or composition — e.g. a
   * `TugProgressIndicator` spinner — that a static Lucide glyph can't express.
   * The node should be sized to fit the 16px icon slot.
   */
  iconSlot?: React.ReactNode;
  /**
   * Optional Lucide icon name rendered in the detail panel (error variant
   * only). Rendered large (48px) on the left of the TugAlert-style layout.
   */
  detailIcon?: string;
  /**
   * Optional bold title rendered above the detail body (error variant only).
   * Matches TugAlert's title shape.
   */
  detailTitle?: string;
  /** Detail panel body content (error variant only). */
  children?: React.ReactNode;
  /**
   * Footer controls. In the `error` variant they pin to the detail
   * panel; in the `status` variant they sit on their own row below the
   * strip (e.g. a Dismiss button for a soft, non-blocking notice).
   */
  footer?: React.ReactNode;
  /**
   * Disables the `inert` application on `.tug-pane-body` — for gallery demos
   * that render the banner inside a preview without blocking interaction.
   * The visual strip and detail panel still render normally.
   * @default false
   */
  contained?: boolean;
  /**
   * Floor on visibility duration in milliseconds. After the banner first
   * paints with `visible: true`, subsequent `visible: false` requests are
   * held until at least this many milliseconds have elapsed since first
   * paint, then the existing exit animation runs.
   *
   * The hold prevents flash-and-vanish: a parent that mounts the banner
   * for a transient state and tears it down within ~50ms (e.g. a JSONL
   * replay that resolves before the soft-budget fires) would otherwise
   * leave the user looking at sub-perceptual motion they can't read.
   *
   * Once an exit is committed (deferral pending or animation in flight),
   * subsequent `visible: true` is ignored until the banner has fully
   * unmounted — matching the rule that an ordered-out banner cannot be
   * revived. After the unmount, a fresh `visible: true` starts a new
   * enter cycle.
   *
   * Pass `0` to opt out entirely.
   * @default 500
   */
  minMountedMs?: number;
  /**
   * Clock injection for tests. Defaults to `performance.now`. The gate
   * compares `nowMs() - shownAt` against `minMountedMs`; tests can inject
   * a controllable clock so the deferral computation is deterministic
   * without racing the wall clock. Production code never needs to set
   * this.
   * @internal
   */
  nowMs?: () => number;
  /** Additional CSS class names. */
  className?: string;
}

/* ---------------------------------------------------------------------------
 * TugPaneBanner
 * ---------------------------------------------------------------------------*/

export const TugPaneBanner = React.forwardRef<HTMLDivElement, TugPaneBannerProps>(
  function TugPaneBanner(
    {
      visible,
      variant = "error",
      tone = "danger",
      label,
      message,
      icon,
      iconSlot,
      detailIcon,
      detailTitle,
      children,
      footer,
      contained = false,
      minMountedMs = 500,
      nowMs,
      className,
    },
    ref,
  ) {
    const cardEl = useContext(TugPanePortalContext);
    // Stable clock reference. The default (performance.now) is monotonic and
    // unaffected by wall-clock skew. Captured in a ref so the gate's logic
    // doesn't depend on prop identity for re-runs.
    const nowFnRef = useRef<() => number>(nowMs ?? (() => performance.now()));
    nowFnRef.current = nowMs ?? (() => performance.now());
    // Per-card banner-lifecycle plumbing. cardId is read from
    // `CardIdContext` (provided by `CardHost`); when this banner is
    // rendered outside a card host (gallery preview, standalone
    // harness) cardId is null and lifecycle emission is skipped —
    // there's no per-card subscriber to notify.
    const cardIdForLifecycle = useContext(CardIdContext);
    const bannerLifecycle = useBannerLifecycle();

    const rootRef = useRef<HTMLDivElement | null>(null);
    const stripRef = useRef<HTMLDivElement | null>(null);
    const detailRef = useRef<HTMLDivElement | null>(null);

    // Presence: keep the portal mounted across the exit animation. `mounted`
    // becomes true when visible first goes true; it only becomes false after
    // the exit animation's `.finished` resolves.
    const [mounted, setMounted] = useState(false);

    // ---- Min-mount-time gate state ------------------------------------
    // Recorded on the first paint of visible content (in the enter-animation
    // effect, guarded by a null check). The exit branch reads this to
    // compute how much longer the banner must stay before the slide-out
    // can begin. Cleared when the gated exit completes so the next
    // visible: true cycle starts fresh.
    const shownAtRef = useRef<number | null>(null);
    // Set to true the first time (!visible && mounted) fires. Once true,
    // the parent's visible: true / visible: false toggles are ignored
    // until the unmount completes — the user-stated rule that an
    // ordered-out banner cannot be revived.
    const committedToExitRef = useRef(false);
    // Pending setTimeout handle for the deferred exit. Cleanup paths
    // (effect re-run, component unmount) read this to clear the timer
    // and abandon the deferral.
    const deferredExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Unmount-only safety net for the deferral timer. The gate's
    // commitment is binding once `committedToExitRef` is set, which
    // means the exit effect intentionally does NOT return a cleanup
    // that clears the timer on re-runs (so visible: true mid-deferral
    // doesn't unwind the gate). The trade-off: when the parent
    // unmounts the banner mid-deferral, no effect cleanup catches the
    // pending timer, the closure stays alive until the timer fires,
    // and `runExit` runs on detached DOM (harmless but wasteful). This
    // empty-deps effect closes that gap — its cleanup runs once on
    // unmount and clears any pending timer so the closure can be
    // collected promptly. Mirrors the same pattern in TugBanner.
    useLayoutEffect(() => {
      return () => {
        if (deferredExitTimerRef.current !== null) {
          clearTimeout(deferredExitTimerRef.current);
          deferredExitTimerRef.current = null;
        }
      };
    }, []);

    // Stable renderable props through the exit animation. When the
    // parent flips `visible` from true → false, it commonly drops
    // the matching content props at the same render — message, icon,
    // iconSlot, label, detail children, footer — either because it
    // consolidated to "no banner" (nothing left to say) or because
    // the kind transitioned. If we honor the new (empty) props
    // mid-exit, the strip's content vanishes in one frame and the
    // empty strip slides off invisibly; user sees a hop, not an
    // animation. Hold every renderable prop the banner had on its
    // last visible render so the exit slide carries the content the
    // user saw a frame ago.
    const lastVisiblePropsRef = useRef({
      variant,
      tone,
      label,
      message,
      icon,
      iconSlot,
      detailIcon,
      detailTitle,
      children,
      footer,
    });
    if (visible) {
      lastVisiblePropsRef.current = {
        variant,
        tone,
        label,
        message,
        icon,
        iconSlot,
        detailIcon,
        detailTitle,
        children,
        footer,
      };
    }
    const r = visible
      ? {
          variant,
          tone,
          label,
          message,
          icon,
          iconSlot,
          detailIcon,
          detailTitle,
          children,
          footer,
        }
      : lastVisiblePropsRef.current;

    // Combined ref: internal rootRef + caller's forwarded ref.
    const setRef = useCallback(
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

    // didHide: fires when mounted transitions from true to false
    // (the exit animation's `g.finished` handler has set
    // `mounted=false`, the inert effect has cleared its attribute,
    // and the portaled DOM has been removed). This is the moment
    // body interactivity is restored — focus-claim handlers on a
    // card subscribe here to land focus into the editor after the
    // banner is fully gone.
    //
    // **Load-bearing for editor focus restoration.** The banner sets
    // `inert` on `.tug-pane-body` while mounted, which strips DOM
    // focus from anything inside (including CodeMirror's
    // contentDOM). When the banner exits, the editor is reachable
    // again but unfocused — the user sees no caret. `SessionCardBody`
    // subscribes to `bannerDidHide` and re-focuses the prompt-entry
    // editor here, gated on first-responder state. Per the contract
    // documented in `session-card.tsx` (the focus-claim handlers
    // block) and pinned by
    // `tests/app-test/at0175-session-mount-focus.test.ts`: any new
    // overlay-class component that sets `inert` on the pane body
    // MUST emit a per-card `didHide` lifecycle event after `inert`
    // clears, mirroring this emission. Removing or gating this
    // emission breaks at0051 — that's intentional.
    //
    // Registered BEFORE the presence effect so that during a gated
    // auto-restart (finishExit calls setMounted(false), then the
    // presence effect's `mounted` dep re-fires it with visible still
    // true), didHide fires first and willShow fires second. The
    // intuitive order is "the prior cycle finished, then a new one
    // begins."
    const prevMountedForLifecycleRef = useRef(false);
    useLayoutEffect(() => {
      if (
        prevMountedForLifecycleRef.current
        && !mounted
        && cardIdForLifecycle !== null
        && bannerLifecycle !== null
      ) {
        bannerLifecycle.notifyBannerDidHide(cardIdForLifecycle);
      }
      prevMountedForLifecycleRef.current = mounted;
    }, [mounted, cardIdForLifecycle, bannerLifecycle]);

    // Promote to mounted on first visible=true. Exit flips mounted back to
    // false in the exit-animation effect below.
    //
    // Banner-lifecycle event emission. willShow / willHide fire on
    // `visible` transitions (and the first-render `visible=true`
    // case, where prevVisible starts false). didShow fires when the
    // enter animation finishes; didHide fires when `mounted`
    // transitions to false (in a separate effect above). Per-card
    // scope: cardId comes from CardIdContext; null cardId skips
    // emission cleanly. [L24]
    const prevVisibleForLifecycleRef = useRef(false);
    useLayoutEffect(() => {
      // Once the gate has committed to exit, the parent's visible toggles
      // are ignored — no presence flips, no lifecycle event emission, no
      // prev-tracking updates. The reset in the exit-finished handler
      // re-arms prev-tracking so a fresh post-unmount visible: true is
      // detected as a clean new cycle. Note: the order of effects is
      // (didHide above) then (presence) then (exit). On the FIRST
      // visible: true → false transition, committedToExitRef is still
      // false here, so the willHide event fires correctly; the exit
      // effect that follows in the same render flips committedToExitRef.
      //
      // `mounted` is in the dep list so this effect re-runs when
      // finishExit calls setMounted(false). That re-run is what restarts
      // a fresh enter cycle if the parent re-asserted visible: true
      // while the gate was committed (the presence effect ignored the
      // re-entry then; honoring it here, after the gate resets, is the
      // "fresh visible: true after the unmount" case from the spec).
      if (committedToExitRef.current) return;
      if (visible) setMounted(true);
      if (cardIdForLifecycle !== null && bannerLifecycle !== null) {
        const prev = prevVisibleForLifecycleRef.current;
        if (visible && !prev) {
          bannerLifecycle.notifyBannerWillShow(cardIdForLifecycle);
        } else if (!visible && prev) {
          bannerLifecycle.notifyBannerWillHide(cardIdForLifecycle);
        }
      }
      prevVisibleForLifecycleRef.current = visible;
    }, [visible, mounted, cardIdForLifecycle, bannerLifecycle]);

    // Inert management keyed on `mounted`. When the banner is in the DOM the
    // card body is inert; when the exit animation finishes and mounted goes
    // back to false, inert is released in the same React commit. Cleanup on
    // unmount always clears — we never want to leak an `inert` attribute
    // after the component goes away.
    useLayoutEffect(() => {
      if (contained) return;
      if (!cardEl) return;
      const body = paneBodyOf(cardEl);
      if (!body) return;
      if (mounted) {
        body.setAttribute("inert", "");
      } else {
        body.removeAttribute("inert");
      }
      return () => {
        body.removeAttribute("inert");
      };
    }, [mounted, cardEl, contained]);

    // Enter animation: runs when (visible && mounted). The first mount with
    // visible=true pipeline is: (render null) → effect sets mounted=true →
    // re-render with DOM present → this effect runs on the DOM.
    useLayoutEffect(() => {
      if (!visible || !mounted) return;
      // If the gate has committed to exit, the parent flipping visible
      // back to true does not restart the enter animation. The dwell +
      // exit completes; only after the unmount can a fresh cycle begin.
      if (committedToExitRef.current) return;
      const strip = stripRef.current;
      const detail = detailRef.current;
      if (!strip) return;

      // Record shownAt at first paint of visible content. The null
      // guard ensures dependency-only re-runs (cardIdForLifecycle /
      // bannerLifecycle changing under a stable visible+mounted) don't
      // reset the timestamp. This effect runs in the post-`setMounted`
      // commit, ~one frame closer to actual paint than the presence
      // effect — a more honest "first visible on screen" floor.
      if (shownAtRef.current === null) {
        shownAtRef.current = nowFnRef.current();
      }

      const g = group({ duration: "--tug-motion-duration-moderate" });
      g.animate(
        strip,
        [{ transform: "translateY(-100%)" }, { transform: "translateY(0)" }],
        { key: "pane-banner-strip", easing: "ease-out" },
      );
      if (detail) {
        g.animate(detail, [{ opacity: 0 }, { opacity: 1 }], {
          key: "pane-banner-detail",
        });
      }
      // didShow fires after the enter animation completes — the
      // banner is fully presented and (for non-`contained` banners)
      // inert is set on `.tug-pane-body`.
      g.finished.then(() => {
        if (cardIdForLifecycle !== null && bannerLifecycle !== null) {
          bannerLifecycle.notifyBannerDidShow(cardIdForLifecycle);
        }
      }).catch(() => {
        // Animation interrupted — the next visible→mounted transition
        // (or unmount) will fire its own lifecycle event.
      });
    }, [visible, mounted, cardIdForLifecycle, bannerLifecycle]);

    // Exit animation: runs when (!visible && mounted). Unmounts the portal
    // content only after `.finished` resolves so the exit animation plays
    // to completion.
    //
    // Min-mount-time gate: if the banner has been visible for less than
    // `minMountedMs`, the slide-out is deferred until the floor is reached.
    // During the deferral the banner keeps rendering its held props
    // (`lastVisiblePropsRef` already handles the prop hold). Once the
    // deferral fires, today's animation + .finished → setMounted(false)
    // chain runs unchanged.
    //
    // The gate's commitment is one-shot and binding: once
    // committedToExitRef is set, the deferral runs to completion
    // regardless of subsequent visible toggles. The exit effect is
    // idempotent — re-runs while committed are no-ops, and the cleanup
    // does not tear down a pending timer because the gate's contract is
    // "an ordered-out banner cannot be revived." The `if (committed)
    // return` guard at the top is what makes mid-deferral visible
    // toggles harmless: the deferral keeps its original schedule.
    useLayoutEffect(() => {
      // Already committed: the deferral or in-flight animation owns the
      // exit. Subsequent (!visible && mounted) re-runs are no-ops; we
      // also intentionally do not return a cleanup that clears the
      // timer, so the deferral survives effect re-runs caused by
      // visible flipping back to true mid-deferral. (The auto-restart
      // logic in finishExit handles the "visible is still true after
      // the gate resets" case.)
      if (committedToExitRef.current) return;
      if (visible || !mounted) return;

      const strip = stripRef.current;
      const detail = detailRef.current;

      // Commit to exit on the first (!visible && mounted) edge. Reset
      // happens in `runExit`'s finished/catch handlers.
      committedToExitRef.current = true;

      const finishExit = () => {
        setMounted(false);
        // Reset all gate state so the next visible: true starts a clean
        // cycle. Doing this in both .then and .catch (and the no-DOM
        // shortcut below) keeps the invariant: refs are null/false
        // exactly when `mounted` is false.
        shownAtRef.current = null;
        committedToExitRef.current = false;
        deferredExitTimerRef.current = null;
        // Re-arm willShow for the auto-restart case: if the parent
        // re-asserted visible: true while the gate was committed, the
        // presence effect's re-run (triggered by setMounted(false)
        // above) will see visible=true and prev=false, fire willShow,
        // and call setMounted(true) — starting a fresh enter cycle
        // without the parent needing to toggle visible.
        prevVisibleForLifecycleRef.current = false;
      };

      // No DOM to animate (refs cleared between renders). Skip animation
      // and unmount directly. Still resets gate state so a fresh enter
      // cycle starts clean.
      if (!strip && !detail) {
        finishExit();
        return;
      }

      const runExit = () => {
        deferredExitTimerRef.current = null;
        const g = group({ duration: "--tug-motion-duration-moderate" });
        if (strip) {
          g.animate(
            strip,
            [{ transform: "translateY(0)" }, { transform: "translateY(-100%)" }],
            { key: "pane-banner-strip", easing: "ease-in" },
          );
        }
        if (detail) {
          g.animate(detail, [{ opacity: 1 }, { opacity: 0 }], {
            key: "pane-banner-detail",
          });
        }
        g.finished.then(finishExit).catch(finishExit);
      };

      // shownAt is null only if the banner reached the exit branch
      // without the enter-animation effect having run — unreachable
      // in normal flow because (!visible && mounted) implies a prior
      // (visible && mounted) commit, which would have recorded
      // shownAt. Handle defensively: an unrecorded shownAt means we
      // have no dwell history to honor, so skip the deferral and run
      // the exit immediately. (A `?? now` fallback would compute
      // `remaining = minMountedMs` and defer the FULL floor, which is
      // the opposite of the intent here.)
      if (shownAtRef.current === null) {
        runExit();
        return;
      }

      const remaining = Math.max(
        0,
        minMountedMs - (nowFnRef.current() - shownAtRef.current),
      );

      if (remaining > 0) {
        deferredExitTimerRef.current = setTimeout(runExit, remaining);
        return;
      }

      runExit();
    }, [visible, mounted, minMountedMs]);

    if (!mounted) return null;
    // Contained mode (gallery demos) renders inline inside the caller's
    // positioned parent; no portal, no .tug-pane-body lookup. Real usage
    // requires a portal target from TugPanePortalContext.
    if (!contained && !cardEl) return null;

    // Shared strip markup used by both variants.
    const strip = (
      <div ref={stripRef} className="tug-pane-banner-strip">
        {r.iconSlot !== undefined ? (
          <span className="tug-pane-banner-icon">{r.iconSlot}</span>
        ) : r.icon ? (
          <span className="tug-pane-banner-icon" aria-hidden="true">
            <BannerIcon name={r.icon} />
          </span>
        ) : null}
        {r.label && <span className="tug-pane-banner-label">{r.label}</span>}
        <span className="tug-pane-banner-message">{r.message}</span>
      </div>
    );

    const statusContent = (
      <div
        ref={setRef}
        data-slot="tug-pane-banner"
        data-variant="status"
        data-visible={String(visible)}
        data-tone={r.tone}
        data-contained={contained ? "true" : undefined}
        role="status"
        aria-live="polite"
        className={cn("tug-pane-banner", className)}
      >
        <div className="tug-pane-banner-clip">
          {strip}
          {r.footer !== undefined && (
            <div className="tug-pane-banner-status-actions">{r.footer}</div>
          )}
        </div>
      </div>
    );

    const errorContent = (
      // FocusScope `trapped` reads the live `visible` prop (not the
      // held value): focus must be released the moment the parent
      // dismisses, even though the rest of the banner content keeps
      // rendering for the exit animation.
      <FocusScopeRadix.FocusScope trapped={visible} loop>
        <div
          ref={setRef}
          data-slot="tug-pane-banner"
          data-variant="error"
          data-visible={String(visible)}
          data-tone={r.tone}
          data-contained={contained ? "true" : undefined}
          role="alert"
          aria-live="assertive"
          className={cn("tug-pane-banner", className)}
        >
          <div className="tug-pane-banner-clip">
            {strip}
            <div ref={detailRef} className="tug-pane-banner-detail-panel">
              <div className="tug-pane-banner-detail-body">
                {r.detailIcon && (
                  <div className="tug-pane-banner-detail-icon" aria-hidden="true">
                    <DetailIcon name={r.detailIcon} />
                  </div>
                )}
                <div className="tug-pane-banner-detail-text">
                  {r.detailTitle && (
                    <h2 className="tug-pane-banner-detail-title">{r.detailTitle}</h2>
                  )}
                  {r.children !== undefined && (
                    <div className="tug-pane-banner-detail-message">{r.children}</div>
                  )}
                </div>
              </div>
              {r.footer !== undefined && (
                <div className="tug-pane-banner-detail-actions">{r.footer}</div>
              )}
            </div>
          </div>
        </div>
      </FocusScopeRadix.FocusScope>
    );

    // Pick the layout shape from the variant the banner had on its
    // last visible render so an exit doesn't swap from `error` (with
    // detail panel + FocusScope) to `status` (strip-only) mid-flight.
    const content = r.variant === "status" ? statusContent : errorContent;
    if (contained) return content;
    return createPortal(content, cardEl!);
  },
);

/* ---------------------------------------------------------------------------
 * Icon helpers — render a Lucide icon by kebab-case name
 * ---------------------------------------------------------------------------*/

function resolveLucideIcon(name: string): React.ComponentType<{ size?: number }> | null {
  const pascalName = name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("") as keyof typeof icons;
  const IconComponent = icons[pascalName] as
    | React.ComponentType<{ size?: number }>
    | undefined;
  return IconComponent ?? null;
}

/** Strip-sized (16px) icon shown in the attention strip. */
function BannerIcon({ name }: { name: string }) {
  const IconComponent = resolveLucideIcon(name);
  if (!IconComponent) return null;
  return <IconComponent size={16} />;
}

/** Detail-panel-sized (48px) icon shown in the TugAlert-style layout. */
function DetailIcon({ name }: { name: string }) {
  const IconComponent = resolveLucideIcon(name);
  if (!IconComponent) return null;
  return <IconComponent size={48} />;
}
