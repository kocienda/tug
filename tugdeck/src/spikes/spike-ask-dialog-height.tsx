/**
 * spike-ask-dialog-height.tsx — the app-test ask dialog as one row: where does
 * the timer go?
 *
 * The tall shape is settled out. `AppTestAskDialog` keeps nothing but the
 * question and the two things the developer can do about it:
 *
 *  - **The radio group is gone.** Two actions, `Skip` and `Run`, in the
 *    frame's trailing cluster — which is already built for a balanced pair.
 *  - **The provenance line is gone.** "Requested by a command on this machine"
 *    is the only thing it could have been; saying so carries no information.
 *  - **The file list is gone.** The run prints the names it ran; a consent
 *    prompt does not need to.
 *  - **The timer stays.** It is the only supporting fact on the surface, so
 *    the whole remaining question is where it lives — which is what the three
 *    candidates below differ on, and nothing else.
 *
 * Every candidate is `TugInlineDialog`'s existing `data-layout="header"` shape:
 * no description, no body, no options, `0.625rem 0.75rem` of padding, one row.
 * That costs no new token in the primitive.
 *
 * **What dropping the radios changes, stated plainly.** Today the countdown
 * commits the *selected* option, so moving the selection to "skip" and walking
 * away skips. With two buttons there is no selection to move — the count
 * commits the default button. `Return` and the timeout both mean `Run`,
 * `Escape` means `Skip`, and a developer who wants to skip has to say so. That
 * is a real change to the prompt's semantics and the reason the `Run` button
 * carries the default ring in all three: the ring is now the whole of the
 * preselection.
 *
 * A is the shipped dialog, kept only so the measured heights beside each
 * variant mean something. It is not a candidate.
 *
 * @module spikes/spike-ask-dialog-height
 */

import "./spike.css";
import "./spike-ask-dialog-height.css";

import React from "react";
import { TerminalSquare } from "lucide-react";

import { TugInlineDialog } from "@/components/tugways/tug-inline-dialog";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugRadioGroup, TugRadioItem } from "@/components/tugways/tug-radio-group";

import type { SpikeDef } from "./spike-registry";

// ---------------------------------------------------------------------------
// The real question
// ---------------------------------------------------------------------------

/**
 * The question a gated `just app-test` raises, from the `tugtool host ask`
 * invocation in the `app-test` recipe. Judging a height against invented text
 * judges nothing — though the point of this round is how little of it survives.
 */
const ASK = {
  title: "2 app-tests want to take over the screen",
  files: "at0287-rail-drag-inert-band, at0320-app-test-ask-dialog",
  countdown: 30,
  run: { label: "Run", description: "The other 6 are running now either way" },
  skip: { label: "Skip", description: "Keeps the screen yours" },
} as const;

/** The two actions, in the order the frame's trailing cluster takes them. */
function Actions({
  runLabel,
  count,
}: {
  runLabel?: React.ReactNode;
  count?: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      {count}
      <TugPushButton emphasis="outlined" role="action" size="xs">
        {ASK.skip.label}
      </TugPushButton>
      <TugPushButton emphasis="primary" role="action" size="xs">
        {runLabel ?? ASK.run.label}
      </TugPushButton>
    </>
  );
}

// ---------------------------------------------------------------------------
// Height readout
// ---------------------------------------------------------------------------

/**
 * Wraps a variant and writes its measured height into a badge through a ref.
 *
 * The number is appearance, not state ([L06]) — a dialog that re-rendered
 * itself every time the observer fired would be measuring its own churn.
 */
function Measured({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const targetRef = React.useRef<HTMLDivElement | null>(null);
  const badgeRef = React.useRef<HTMLSpanElement | null>(null);

  React.useLayoutEffect(() => {
    const target = targetRef.current;
    if (target === null) return undefined;
    const write = (): void => {
      if (badgeRef.current === null) return;
      badgeRef.current.textContent = `${Math.round(target.getBoundingClientRect().height)}px`;
    };
    write();
    const observer = new ResizeObserver(write);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="sp-adh-measured">
      <div ref={targetRef} className="sp-adh-target">
        {children}
      </div>
      <span ref={badgeRef} className="sp-adh-height" aria-label="measured height" />
    </div>
  );
}

/** One variant: a letter, a name, the dialog, and what it trades. */
function Variant({
  letter,
  name,
  notes,
  children,
}: {
  letter: string;
  name: string;
  notes: readonly string[];
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="sp-section">
      <h2 className="sp-section-title">
        {letter} — {name}
      </h2>
      <Measured>{children}</Measured>
      <ul className="sp-adh-notes">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// A — as shipped, for scale only
// ---------------------------------------------------------------------------

function AsShipped(): React.ReactElement {
  return (
    <TugInlineDialog
      icon={<TerminalSquare />}
      iconRole="caution"
      title={ASK.title}
      description={
        <>
          <span className="sp-adh-provenance">
            Requested by a command on this machine
          </span>
          <span className="sp-adh-detail">{ASK.files}</span>
        </>
      }
      actions={
        <TugPushButton emphasis="primary" role="action" size="xs">
          Continue
        </TugPushButton>
      }
    >
      <div className="sp-adh-options-centered">
        <TugRadioGroup
          defaultValue="run-all"
          size="md"
          orientation="vertical"
          aria-label={ASK.title}
        >
          <TugRadioItem value="run-all" description={ASK.run.description}>
            Run them
          </TugRadioItem>
          <TugRadioItem value="background" description={ASK.skip.description}>
            Skip them
          </TugRadioItem>
        </TugRadioGroup>
      </div>
      <div className="sp-adh-countdown-line">
        Continues with the selected option in {ASK.countdown}s
      </div>
    </TugInlineDialog>
  );
}

// ---------------------------------------------------------------------------
// B1 — the timer as a numeral ahead of the pair
// ---------------------------------------------------------------------------

function TimerNumeral(): React.ReactElement {
  return (
    <TugInlineDialog
      icon={<TerminalSquare />}
      iconRole="caution"
      title={ASK.title}
      actions={
        <Actions
          count={<span className="sp-adh-count-numeral">{ASK.countdown}s</span>}
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// B2 — the timer inside the button it will press
// ---------------------------------------------------------------------------

function TimerInButton(): React.ReactElement {
  return (
    <div className="sp-adh-wide-actions">
      <TugInlineDialog
        icon={<TerminalSquare />}
        iconRole="caution"
        title={ASK.title}
        actions={
          <Actions
            runLabel={
              <>
                {ASK.run.label}
                <span className="sp-adh-count-in-button">{ASK.countdown}s</span>
              </>
            }
          />
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// B3 — the timer as a rule draining along the frame's bottom edge
// ---------------------------------------------------------------------------

function TimerHairline(): React.ReactElement {
  return (
    <div className="sp-adh-hairline-host">
      <TugInlineDialog
        icon={<TerminalSquare />}
        iconRole="caution"
        title={ASK.title}
        actions={<Actions />}
      />
      <div className="sp-adh-hairline" aria-hidden="true">
        <div className="sp-adh-hairline-fill" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function SpikeAskDialogHeight(): React.ReactElement {
  return (
    <div className="sp-content sp-adh-content">
      <p className="sp-adh-lede">
        One row, two buttons, no radios, no provenance line, no file list. All
        three candidates are the primitive's existing header-only shape, so they
        are the same height — they differ only in where the timer lives. The
        count commits the default button, which is why <code>Run</code> carries
        the ring.
      </p>

      <Variant
        letter="A"
        name="As shipped — reference, not a candidate"
        notes={[
          "Five stacked rows at the frame's 0.875rem gap, over 1.5rem of bottom padding.",
          "Here so the heights below are a ratio rather than an impression.",
        ]}
      >
        <AsShipped />
      </Variant>

      <Variant
        letter="B1"
        name="Timer as a numeral"
        notes={[
          "A tabular numeral ahead of the pair; only the digits are rewritten each tick, through a ref.",
          "Reads as a fact about the dialog rather than about either button — which is honest, since Escape also stops the clock.",
          "Weakest at saying what happens at zero: the numeral sits beside Skip as readily as Run.",
        ]}
      >
        <TimerNumeral />
      </Variant>

      <Variant
        letter="B2"
        name="Timer inside the Run button"
        notes={[
          "What will happen and when, in one place — the button is the countdown.",
          "Costs a wider action slot (6rem) than the frame's 5rem pair, so the cluster no longer reads as balanced.",
          "Tick now rewrites text inside a control; the button must not resize as 30s becomes 9s.",
        ]}
      >
        <TimerInButton />
      </Variant>

      <Variant
        letter="B3"
        name="Timer as a hairline"
        notes={[
          "The count becomes geometry: a 2px rule along the frame's bottom edge, draining to zero. Static here; the real one writes the width through a ref.",
          "Quietest of the three, and the only one that costs no horizontal room at all.",
          "No number anywhere — a developer cannot tell 8 seconds from 3 at a glance, which may be the point or may be the flaw.",
        ]}
      >
        <TimerHairline />
      </Variant>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "ask-dialog-height",
  title: "Ask Dialog Height",
  blurb:
    "The app-test ask dialog as one row, two buttons — where does the timer go?",
  icon: "Ruler",
  component: () => <SpikeAskDialogHeight />,
};
