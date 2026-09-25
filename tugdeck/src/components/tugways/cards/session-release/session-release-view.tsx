/**
 * SessionReleaseView — the Release shade's body ([P12]).
 *
 * Three sections, in the order the release happens: the **check** (what the
 * project's own command printed, and whether it exited 0), the **dispatch**
 * (one button, gated on that exit code, with a confirmed override behind a
 * popover), and the **run** (the watched workflow's steps as they complete).
 * Nothing here knows what a release *is* — the three strings come from the
 * project's `[tugtool.release]` table and the rows are whatever its check
 * printed, so this view is the same on a project that ships a DMG and one
 * that publishes a package ([B09]).
 *
 * **The elapsed counter is a DOM tick, not React state** ([L06]/[L22]): a
 * `setInterval` writes `textContent` on a ref'd span once a second, which
 * re-renders nothing. The only other clock in the release feature is the
 * server's run poll ([L33]/[P11]), and this counter is display — a second
 * hand on a watch somebody else is keeping.
 *
 * **Return does not reach Dispatch.** `session-card.tsx` deliberately does not
 * widen `defaultButtonOwnsReturn` to this shade: on the Changes shade the
 * default button lands a commit, but here it would queue a real release past
 * the override gate, from a reflexive keypress.
 *
 * @module components/tugways/cards/session-release/session-release-view
 */

import "./session-release-view.css";

import React, {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Check, Info, Rocket, X } from "lucide-react";

import { BlockStrip } from "@/components/tugways/blocks/block-strip";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { TugConfirmPopover } from "@/components/tugways/tug-confirm-popover";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { openUrlInOS } from "@/lib/os-open";
import type { CheckRow, RunState, RunStep } from "@/lib/release-store";
import { useReleaseState } from "@/lib/release-store";

export interface SessionReleaseViewProps {
  /** The workspace key every release verb is addressed by ([L29]). */
  workspaceKey: string;
  /** The project's declared release surface; `undefined` when it declares none. */
  release?: { workflow: string };
  /** Dismiss the shade. */
  onClose: () => void;
}

/**
 * The in-flight notes, transcribed from `scripts/watch-release-run.sh`'s
 * `step_note` table (Table T02) so the sheet and the script say the same thing
 * about the same step. The `Post` entry is a prefix — GitHub names every
 * post-job step `Post <whatever ran>`.
 */
const STEP_NOTES: ReadonlyArray<readonly [string, string]> = [
  [
    "Build signed DMG and update archive",
    "compiles the app, signs it, and notarizes — the notary wait is Apple's and can run several minutes",
  ],
  ["Generate the appcast", "resolves Sparkle, then signs the feed"],
  ["Publish the versioned release", "uploads the DMG"],
  [
    "Publish the update feed",
    "uploads the archive and the appcast — installed copies see the update after this",
  ],
];

function stepNote(name: string): string | null {
  for (const [candidate, note] of STEP_NOTES) {
    if (candidate === name) return note;
  }
  if (name.startsWith("Post")) {
    return "post-job cleanup; the release itself is already published";
  }
  return null;
}

/** `Ns` under a minute, `MmSSs` above it. A clock, not a precision instrument. */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** The glyph a completed step's conclusion earns. */
function stepGlyph(step: RunStep): string {
  if (step.status !== "completed") return "…";
  if (step.conclusion === "success") return "✓";
  if (step.conclusion === "skipped" || step.conclusion === "") return "–";
  return "✗";
}

function checkGlyph(mark: CheckRow["mark"]): React.ReactElement {
  if (mark === "ok") return <Check size={12} strokeWidth={2.5} />;
  if (mark === "fail") return <X size={12} strokeWidth={2.5} />;
  return <Info size={12} strokeWidth={2.5} />;
}

/** The one sentence a finished (or given-up-on) watch closes with. */
function runVerdict(run: RunState): string | null {
  const watched = formatDuration(Math.max(0, Date.now() - run.watchedSinceMs));
  if (run.status === "abandoned") {
    return `Tug stopped watching after ${watched} — the run may still be going.`;
  }
  if (run.status !== "completed") return null;
  if (run.conclusion === "success") {
    return `Release run succeeded (watched for ${watched}).`;
  }
  const word = run.conclusion.length > 0 ? run.conclusion : "ended";
  return `Release run ${word} (watched for ${watched}).`;
}

/** The step the run is on right now, or null when none is. */
function inFlightStep(run: RunState | null): RunStep | null {
  if (run === null) return null;
  return run.steps.find((step) => step.status === "in_progress") ?? null;
}

export function SessionReleaseView({
  workspaceKey,
  release,
  onClose,
}: SessionReleaseViewProps): React.ReactElement {
  const { check, dispatch, run, runCheck, runDispatch } =
    useReleaseState(workspaceKey);
  const [rawOpen, setRawOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [overrideAnchor, setOverrideAnchor] = useState<HTMLElement | null>(null);
  const elapsedRef = useRef<HTMLSpanElement | null>(null);

  // The check runs on open, once, and only from idle — reopening the shade over
  // a check that already ran shows what it said rather than running it again.
  // A re-run is the header's `Run check`, which is a gesture the user makes.
  const checkPhase = check.phase;
  useLayoutEffect(() => {
    if (checkPhase === "idle" && release !== undefined) runCheck();
    // `runCheck` is a fresh closure every render (the hook composes it), so it
    // is deliberately not a dependency: listing it would re-fire the check on
    // every commit. The phase is what decides, and it is here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkPhase, release]);

  // The elapsed span, ticked in the DOM ([L06]). Keyed on the in-flight step's
  // identity, so it restarts when the run moves on and stops when nothing is
  // in flight — which is also what clears the interval on the last step.
  const inFlight = inFlightStep(run);
  const inFlightName = inFlight?.name ?? null;
  const inFlightStartedAt = inFlight?.startedAtMs ?? null;
  useLayoutEffect(() => {
    if (inFlightName === null || inFlightStartedAt === null) return;
    const paint = (): void => {
      const node = elapsedRef.current;
      if (node === null) return;
      node.textContent = formatDuration(Date.now() - inFlightStartedAt);
    };
    paint();
    const timer = window.setInterval(paint, 1000);
    return () => window.clearInterval(timer);
  }, [inFlightName, inFlightStartedAt]);

  const onDispatch = useCallback(() => runDispatch(false), [runDispatch]);
  const onOverride = useCallback(() => {
    setOverrideAnchor(null);
    runDispatch(true);
  }, [runDispatch]);

  // Dispatch is live only behind a check that ran and passed, with no dispatch
  // in flight and no run still going — queueing a second release over a live
  // one is the one gesture this sheet must never make easy.
  const runSettled =
    run === null || run.status === "completed" || run.status === "abandoned";
  // The server's own re-check is the current answer, and it outranks the one on
  // screen: it looked at a newer tree. So a refusal that carried rows both
  // closes Dispatch and arms the override — without which the sheet would say
  // "dispatch anyway to override it" in its error line beside a Dispatch button
  // that will only be refused again, and no override at all.
  const serverRefused = dispatch.phase === "error" && dispatch.rows.length > 0;
  const dispatchEnabled =
    check.phase === "done" &&
    check.passed &&
    !serverRefused &&
    dispatch.phase !== "pending" &&
    runSettled;
  const overrideOffered =
    check.phase === "done" &&
    (!check.passed || serverRefused) &&
    dispatch.phase !== "pending" &&
    runSettled;

  const header = (
    <BlockStrip
      altitude="section"
      className="tool-call-header"
      dataTestid="session-release-header"
      leading={
        <span className="tool-call-header-leading tug-line-box" aria-hidden="true">
          <Rocket size={14} />
        </span>
      }
      name="Release"
      detail={
        release !== undefined ? (
          <span className="session-release-workflow">{release.workflow}</span>
        ) : undefined
      }
      actions={
        <>
          <TugTooltip content="Run the release check again">
            <TugPushButton
              subtype="text"
              size="2xs"
              emphasis="outlined"
              role="action"
              label="Run check"
              aria-label="Run the release check again"
              data-testid="session-release-recheck"
              disabled={check.phase === "running" || release === undefined}
              onClick={(event) => {
                event?.stopPropagation();
                runCheck();
              }}
            />
          </TugTooltip>
          <TugTooltip content="Close the Release shade">
            <TugPushButton
              subtype="icon"
              icon={<X size={14} strokeWidth={2.5} />}
              size="xs"
              emphasis="ghost"
              role="action"
              aria-label="Close the Release shade"
              data-testid="session-release-dismiss"
              onClick={(event) => {
                event?.stopPropagation();
                onClose();
              }}
            />
          </TugTooltip>
        </>
      }
    />
  );

  // The rows a refused dispatch carried stand in for the check's own when the
  // server's re-check is what said no — it looked at a newer tree than the
  // check on screen did, so its answer is the current one.
  const rows: readonly CheckRow[] = serverRefused ? dispatch.rows : check.rows;

  return (
    <>
      <div className="tug-sheet-shade-header">{header}</div>
      <div
        className="session-release-view"
        data-slot="session-release-view"
        data-tug-focus="refuse"
      >
        {release === undefined ? (
          <div className="session-release-empty">
            This project declares no <code>[tugtool.release]</code> table, so
            Tug does not know what a release is here.
          </div>
        ) : (
          <>
            <section className="session-release-section" data-section="check">
              {check.phase === "running" ? (
                <div className="session-release-note">Running the check…</div>
              ) : null}
              {check.phase === "error" ? (
                <div className="session-release-error" data-testid="session-release-check-error">
                  {check.error}
                </div>
              ) : null}
              {rows.map((row, index) => (
                <TugListRow
                  key={`${row.mark}:${index}:${row.text}`}
                  variant="flush"
                  density="compact"
                  data-mark={row.mark}
                  data-testid="session-release-row"
                  leading={
                    <span className="session-release-mark" aria-hidden="true">
                      {checkGlyph(row.mark)}
                    </span>
                  }
                  title={row.text}
                  titleSize="sm"
                />
              ))}
              {check.raw !== null && check.raw.length > 0 ? (
                <div className="session-release-raw">
                  <BlockFoldCue
                    collapsed={!rawOpen}
                    onToggle={(next) => setRawOpen(!next)}
                    collapsedLabel="Show output"
                    expandedLabel="Hide output"
                    ariaLabelExpand="Show the check's whole output"
                    ariaLabelCollapse="Hide the check's whole output"
                    size="2xs"
                  />
                  {rawOpen ? (
                    <pre
                      className="session-release-pre"
                      data-testid="session-release-raw"
                    >
                      {check.raw}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </section>

            <section className="session-release-section" data-section="dispatch">
              <TugPushButton
                subtype="text"
                size="xs"
                emphasis="filled"
                role="accent"
                label="Dispatch"
                data-testid="session-release-dispatch"
                disabled={!dispatchEnabled}
                onClick={(event) => {
                  event?.stopPropagation();
                  onDispatch();
                }}
              />
              {overrideOffered ? (
                <TugPushButton
                  subtype="text"
                  size="xs"
                  emphasis="ghost"
                  role="action"
                  label="Dispatch anyway…"
                  data-testid="session-release-dispatch-anyway"
                  onClick={(event) => {
                    setOverrideAnchor(
                      (event?.currentTarget as HTMLElement | undefined) ?? null,
                    );
                  }}
                />
              ) : null}
              {dispatch.phase === "pending" ? (
                <span className="session-release-note">Queueing the run…</span>
              ) : null}
              {dispatch.phase === "error" ? (
                <div
                  className="session-release-error"
                  data-testid="session-release-dispatch-error"
                >
                  {dispatch.error}
                </div>
              ) : null}
            </section>

            {run !== null ? (
              <section className="session-release-section" data-section="run">
                <div className="session-release-run-head">
                  {run.url.length > 0 ? (
                    <TugPushButton
                      subtype="text"
                      size="2xs"
                      emphasis="ghost"
                      role="action"
                      label={`Run ${run.runId} on GitHub`}
                      data-testid="session-release-run-link"
                      onClick={(event) => {
                        event?.stopPropagation();
                        openUrlInOS(run.url);
                      }}
                    />
                  ) : (
                    <span className="session-release-note">Run {run.runId}</span>
                  )}
                </div>
                {run.status === "unreachable" ? (
                  <div
                    className="session-release-note"
                    data-testid="session-release-unreachable"
                  >
                    (no answer from GitHub — retrying)
                  </div>
                ) : null}
                {run.steps.map((step, index) => (
                  <div
                    // Index-qualified: `parse_run_snapshot` flattens the steps
                    // of every job, and a multi-job workflow repeats the names
                    // GitHub adds itself ("Set up job", "Complete job").
                    key={`${index}:${step.name}`}
                    className="session-release-step"
                    data-testid="session-release-step"
                    data-status={step.status}
                  >
                    <span className="session-release-step-line">
                      <span className="session-release-mark" aria-hidden="true">
                        {stepGlyph(step)}
                      </span>
                      <span className="session-release-step-name">
                        {step.name}
                      </span>
                      {step.status === "completed" ? (
                        <span className="session-release-step-time">
                          {step.startedAtMs !== null &&
                          step.completedAtMs !== null
                            ? formatDuration(
                                step.completedAtMs - step.startedAtMs,
                              )
                            : ""}
                        </span>
                      ) : step.status === "in_progress" ? (
                        <span className="session-release-step-time">
                          <span ref={elapsedRef} /> elapsed
                        </span>
                      ) : null}
                    </span>
                    {step.status === "in_progress" &&
                    stepNote(step.name) !== null ? (
                      <span className="session-release-step-note">
                        {stepNote(step.name)}
                      </span>
                    ) : null}
                  </div>
                ))}
                {runVerdict(run) !== null ? (
                  <div
                    className="session-release-verdict"
                    data-testid="session-release-verdict"
                  >
                    {runVerdict(run)}
                  </div>
                ) : null}
                {run.failedLog !== null ? (
                  <div className="session-release-raw">
                    <BlockFoldCue
                      collapsed={!logOpen}
                      onToggle={(next) => setLogOpen(!next)}
                      collapsedLabel="Show the failed step's log"
                      expandedLabel="Hide the failed step's log"
                      ariaLabelExpand="Show the failed step's log"
                      ariaLabelCollapse="Hide the failed step's log"
                      size="2xs"
                    />
                    {logOpen ? (
                      <pre
                        className="session-release-pre"
                        data-testid="session-release-failed-log"
                      >
                        {run.failedLog}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </div>
      {/* One controlled confirm, anchored to the override button that armed it.
          `confirmRole="danger"` puts default focus on Cancel, so a reflexive
          Return can never queue a release behind a failing check. */}
      <TugConfirmPopover
        open={overrideAnchor !== null}
        anchorEl={overrideAnchor}
        message="The check did not pass. Dispatch anyway, then fix the check?"
        confirmLabel="Dispatch anyway"
        confirmRole="danger"
        side="top"
        onConfirm={onOverride}
        onCancel={() => setOverrideAnchor(null)}
      />
    </>
  );
}
