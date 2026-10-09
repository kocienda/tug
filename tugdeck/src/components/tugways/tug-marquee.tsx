/**
 * TugMarquee — single-line scrolling label with seamless loop.
 *
 * Displays one line of text. If the text fits, renders statically.
 * If it overflows, loops seamlessly with pause-scroll-snap cycle.
 * Animation via CSS transition on transform, orchestrated by direct
 * DOM manipulation — no React state drives appearance.
 *
 * Laws: [L06] appearance via CSS/DOM, [L19] component authoring guide
 */

import "./tug-marquee.css";

import React, { useRef, useLayoutEffect, useCallback } from "react";
import { cn } from "@/lib/utils";

// ---- Constants ----

/** Default gap between copy 1 and copy 2, in em units */
const DEFAULT_GAP = 3.6;

// ---- Types ----

/** TugMarquee size names — matches TugLabel sizes */
export type TugMarqueeSize = "sm" | "md" | "lg";

/**
 * TugMarquee props.
 */
export interface TugMarqueeProps extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** Text content (single line) */
  children: string;
  /**
   * Enable marquee animation when text overflows.
   * @default true
   */
  animate?: boolean;
  /**
   * Scroll speed in pixels per second.
   * @default 30
   */
  speed?: number;
  /**
   * Pause time in milliseconds at the start position.
   * @default 2000
   */
  pauseTime?: number;
  /**
   * Gap between text copies in em units.
   * @default 3.6
   */
  gap?: number;
  /**
   * Size variant.
   * @selector .tug-marquee-size-sm | .tug-marquee-size-md | .tug-marquee-size-lg
   * @default "md"
   */
  size?: TugMarqueeSize;
  /** Leading icon (React node, typically a Lucide icon) */
  icon?: React.ReactNode;
  /** Icon color (CSS value or token). Defaults to label text color. */
  iconColor?: string;
}

// ---- TugMarquee ----

export const TugMarquee = React.forwardRef<HTMLDivElement, TugMarqueeProps>(
  function TugMarquee(
    {
      children,
      animate = true,
      speed = 30,
      pauseTime = 2000,
      gap = DEFAULT_GAP,
      size = "md",
      icon,
      iconColor,
      className,
      style,
      ...rest
    },
    ref,
  ) {
    const trackRef = useRef<HTMLDivElement>(null);
    const stripRef = useRef<HTMLSpanElement>(null);
    const copy1Ref = useRef<HTMLSpanElement>(null);
    // Refs for the animation cycle — no React state, pure DOM orchestration
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const animatingRef = useRef(false);

    // Shared transitionend handler (assigned in scroll, needs stable ref).
    // Must be useCallback so cleanup and startCycle always share the same reference.
    const handleTransitionEndRef = useRef<(() => void) | null>(null);

    const handleTransitionEnd = useCallback(() => {
      handleTransitionEndRef.current?.();
    }, []);

    const cleanup = useCallback(() => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      animatingRef.current = false;
      // Remove transitionend listener if strip exists
      const strip = stripRef.current;
      if (strip) {
        strip.removeEventListener("transitionend", handleTransitionEnd);
      }
    }, [handleTransitionEnd]);

    const startCycle = useCallback(() => {
      const track = trackRef.current;
      const strip = stripRef.current;
      const copy1 = copy1Ref.current;
      if (!track || !strip || !copy1) return;

      cleanup();

      // Measure in scrolling state so copy 1 is unconstrained (full text width)
      track.classList.remove("tug-marquee-static", "tug-marquee-paused");
      track.classList.add("tug-marquee-scrolling");
      strip.style.removeProperty("--tug-marquee-distance");
      strip.style.setProperty("--tug-marquee-duration", "0s");

      const trackWidth = track.offsetWidth;
      const textWidth = copy1.offsetWidth;

      // Set track width for copy truncation (used by both copy 1 in paused
      // state and copy 2 always)
      track.style.setProperty("--tug-marquee-track-width", `${trackWidth}px`);

      if (textWidth <= trackWidth || !animate) {
        // Text fits — static display, single copy with ellipsis
        track.classList.remove("tug-marquee-scrolling", "tug-marquee-paused");
        track.classList.add("tug-marquee-static");
        strip.style.removeProperty("--tug-marquee-distance");
        strip.style.removeProperty("--tug-marquee-duration");
        return;
      }

      // Text overflows — start the seamless loop cycle
      animatingRef.current = true;

      // Scroll distance = copy1 full width + flex gap.
      // Measure gap from the strip's computed column-gap.
      const gapPx = parseFloat(getComputedStyle(strip).columnGap) || 0;
      const scrollDistance = textWidth + gapPx;

      function pause() {
        if (!animatingRef.current || !track || !strip) return;

        // Switch to paused — copy 1 gets truncation, transform snaps to 0.
        // Since copy 2 (truncated) was at position 0 at scroll end, and
        // copy 1 (now truncated) is at position 0 in paused state, the
        // visual frame is identical — no pop.
        track.classList.remove("tug-marquee-scrolling", "tug-marquee-static");
        track.classList.add("tug-marquee-paused");

        timerRef.current = setTimeout(() => {
          scroll();
        }, pauseTime);
      }

      function scroll() {
        if (!animatingRef.current || !track || !strip) return;

        const duration = scrollDistance / speed;
        strip.style.setProperty("--tug-marquee-distance", `-${scrollDistance}px`);
        strip.style.setProperty("--tug-marquee-duration", `${duration}s`);

        // Force reflow so the browser registers the paused transform(0)
        // before we switch to scrolling (otherwise it may skip the transition)
        void strip.offsetWidth;

        // Switch to scrolling — copy 1 loses truncation (the one allowed pop),
        // CSS transition kicks in
        track.classList.remove("tug-marquee-paused", "tug-marquee-static");
        track.classList.add("tug-marquee-scrolling");

        // When scroll completes, go to pause (invisible snap — same visual frame)
        handleTransitionEndRef.current = () => {
          strip.removeEventListener("transitionend", handleTransitionEnd);
          if (animatingRef.current) {
            pause();
          }
        };
        strip.addEventListener("transitionend", handleTransitionEnd);
      }

      // Begin with pause (initial display with ellipsis clipping)
      pause();
    }, [animate, speed, pauseTime, cleanup, handleTransitionEnd]);

    // Start/restart cycle when text or animation props change
    useLayoutEffect(() => {
      startCycle();
      return cleanup;
    }, [children, animate, speed, pauseTime, gap, startCycle, cleanup]);

    // Observe container resize to re-evaluate overflow.
    // Debounce via rAF to avoid "ResizeObserver loop completed with
    // undelivered notifications" — the callback triggers layout changes
    // that would fire another notification in the same frame.
    useLayoutEffect(() => {
      const track = trackRef.current;
      if (!track) return;

      let rafId = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          startCycle();
        });
      });
      observer.observe(track);
      return () => {
        cancelAnimationFrame(rafId);
        observer.disconnect();
      };
    }, [startCycle]);

    const marqueeClassName = cn(
      "tug-marquee",
      `tug-marquee-size-${size}`,
      className,
    );

    return (
      <div ref={ref} data-slot="tug-marquee" className={marqueeClassName} style={style} {...rest}>
        {icon && (
          <span
            className="tug-marquee-icon"
            style={iconColor ? { color: iconColor } : undefined}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
        <div ref={trackRef} className="tug-marquee-track tug-marquee-static">
          <span ref={stripRef} className="tug-marquee-strip" style={{ gap: `${gap}em` }}>
            <span ref={copy1Ref} className="tug-marquee-copy1">{children}</span>
            <span className="tug-marquee-copy2">{children}</span>
          </span>
        </div>
      </div>
    );
  },
);
