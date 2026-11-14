/**
 * claude-download-progress — the Claude Code download's bar and byte line.
 *
 * Two wizards draw this transfer: ConfigureTug's install row, and UpdateTug's
 * Claude Code row when an offered Tug needs a newer Claude Code than the one
 * installed. It is one download, reported on one store, so it is drawn by one
 * pair of components; each wizard passes only the test id its own tests read.
 *
 * [L06] — both are painted from a direct `authStore` subscription onto their
 * own element and never render: tugcast publishes on every whole percent, and
 * routing that through React would re-render a wizard for a word.
 *
 * @module components/tugways/claude-download-progress
 */

import { type ReactElement, useLayoutEffect, useState } from "react";

import { authStore } from "@/lib/auth-store";
import {
  newRateEstimator,
  transferDetailLine,
  type RateEstimator,
} from "@/lib/transfer-rate";
import { TugProgressIndicator } from "./tug-progress-indicator";

/**
 * The download's bar, painted rather than rendered.
 *
 * The same seam the update wizard's own bar uses, over `authStore` instead:
 * the fraction goes onto the custom property, `data-painted` switches the bar
 * off the barber pole, and `aria-valuenow` is there for anyone reading the row
 * rather than looking at it. Indeterminate until a total is known, which for
 * this download means until the manifest has been read — and forever on the
 * script fallback, which reports nothing at all.
 */
export function ClaudeDownloadBar({ testId }: { testId: string }): ReactElement {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    if (el === null) return;
    const paint = (): void => {
      const { receivedBytes, expectedBytes } = authStore.getSnapshot();
      if (expectedBytes <= 0) {
        el.style.removeProperty("--tugx-progress-indicator-value");
        el.removeAttribute("data-painted");
        el.removeAttribute("aria-valuenow");
        return;
      }
      const fraction = Math.min(1, receivedBytes / expectedBytes);
      el.style.setProperty("--tugx-progress-indicator-value", String(fraction));
      el.setAttribute("data-painted", "");
      el.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
    };
    paint();
    return authStore.subscribe(paint);
  }, [el]);
  return (
    <TugProgressIndicator
      ref={setEl}
      variant="bar"
      state="running"
      size={6}
      aria-label="Download progress"
      data-testid={testId}
    />
  );
}

/**
 * The download's detail line — bytes, rate and time remaining — written onto
 * its own span from a direct store subscription.
 *
 * The rate is measured here from the (bytes, time) pairs the store hands over,
 * exactly as the update wizard measures its own: how fast and how much longer
 * are what a person watching a slow download is actually deciding on.
 */
export function ClaudeDownloadDetail({ testId }: { testId: string }): ReactElement {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    if (el === null) return;
    // In the closure rather than a ref: it resets when the row unmounts, which
    // is exactly when a new transfer starts.
    let rate: RateEstimator = newRateEstimator();
    const paint = (): void => {
      const { receivedBytes, expectedBytes } = authStore.getSnapshot();
      rate = rate.sample(receivedBytes, performance.now());
      el.textContent = transferDetailLine(
        receivedBytes,
        expectedBytes,
        rate.bytesPerSecond,
      );
      if (expectedBytes <= 0) el.removeAttribute("data-progress");
      else
        el.setAttribute(
          "data-progress",
          String(Math.floor((receivedBytes / expectedBytes) * 100)),
        );
    };
    paint();
    return authStore.subscribe(paint);
  }, [el]);
  return <span ref={setEl} data-testid={testId} />;
}
