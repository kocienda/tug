/**
 * `ShellLiveBand` — what a running `$`-route command's block says while it
 * runs: how long it has run and how long ago it last printed, and, once the
 * shell has asked about it, the question with its two answers.
 *
 * It is the `liveBand` of the exchange's `BlockChrome`, so it shows whether
 * the block is collapsed or open. The reading is a notice band in the
 * `progress` tone, the same line a running Bash block narrates itself on.
 * The question is a second row under it: "No output for 2 minutes. This
 * command might be stuck." with **Terminate** and **Keep Waiting**. Neither
 * button is pressed for the user: an unanswered question leaves the command
 * running, and the next output takes the question down.
 *
 * The shell session arrives by `RunOfferShellContext`, the door a runnable
 * offer's frame takes it through. Outside a provider nothing renders.
 *
 * Laws:
 *  - [L02] whether a question stands enters React through
 *    `useSyncExternalStore`, taken from the gesture scope's door; the snapshot is the store's own object, so a
 *    piece of output that changes nothing about the question renders nothing.
 *  - [L06] the clock is text written to the DOM once a second, never state.
 *  - [L22] the liveness store drives that write directly.
 *  - [L19] file pair, `data-slot` on the root.
 *
 * @module components/tugways/cards/shell-live-band
 */

import React from "react";

import { BlockNoticeBand } from "../blocks/block-notice";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  LivenessClock,
  QUIET_KEEP_LABEL,
  QUIET_TERMINATE_LABEL,
  quietQuestion,
  setLivenessReading,
} from "@/lib/run-liveness";
import type { RunQuiet } from "@/lib/run-offer-store";
import type { ShellSessionStore } from "@/lib/shell-session-store";
import { RunOfferShellContext } from "./use-run-offers";
import "./shell-live-band.css";

export interface ShellLiveBandProps {
  /** The running exchange. */
  exchangeId: string;
  /** When it started, for a reading taken before the store has one. */
  startedAtMs: number;
}

export const ShellLiveBand: React.FC<ShellLiveBandProps> = (props) => {
  const shell = React.useContext(RunOfferShellContext);
  if (shell === null) return null;
  return <LiveBand shell={shell} {...props} />;
};

const LiveBand: React.FC<ShellLiveBandProps & { shell: ShellSessionStore }> = ({
  shell,
  exchangeId,
  startedAtMs,
}) => {
  const quiet = useSyncExternalStore(
    shell.liveness.subscribe,
    (): RunQuiet | null => {
      const live = shell.liveness.get();
      return live !== null && live.exchangeId === exchangeId ? live.quiet : null;
    },
  );

  const clockRef = React.useRef<HTMLSpanElement | null>(null);
  React.useLayoutEffect(() => {
    const reading = clockRef.current;
    if (reading === null) return;
    const point = (): void => {
      const live = shell.liveness.get();
      const mine = live !== null && live.exchangeId === exchangeId ? live : null;
      setLivenessReading(
        reading,
        mine?.startedAtMs ?? startedAtMs,
        mine?.lastOutputAtMs ?? null,
        Date.now(),
      );
    };
    point();
    const release = shell.liveness.subscribe(point);
    const clock = new LivenessClock(() => reading.parentElement);
    clock.check();
    return () => {
      release();
      clock.stop();
    };
  }, [shell, exchangeId, startedAtMs]);

  return (
    <div data-slot="shell-live-band" className="shell-live-band">
      <BlockNoticeBand
        tone="progress"
        maxLines={1}
        text={<span ref={clockRef} className="shell-live-clock" />}
      />
      {quiet !== null ? (
        <div
          data-slot="shell-quiet-band"
          className="shell-quiet-band"
          role="group"
          aria-label="This command has gone quiet"
        >
          <span className="shell-quiet-text">{quietQuestion(quiet.quietMs)}</span>
          <TugPushButton
            data-slot="shell-quiet-terminate"
            emphasis="outlined"
            size="xs"
            onClick={() => shell.kill()}
          >
            {QUIET_TERMINATE_LABEL}
          </TugPushButton>
          <TugPushButton
            data-slot="shell-quiet-keep"
            emphasis="outlined"
            size="xs"
            onClick={() => shell.keepWaiting()}
          >
            {QUIET_KEEP_LABEL}
          </TugPushButton>
        </div>
      ) : null}
    </div>
  );
};
