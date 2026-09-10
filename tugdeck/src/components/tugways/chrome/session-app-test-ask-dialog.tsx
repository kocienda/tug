/**
 * `AppTestAskDialog` — the inline dialog for a question raised from outside the
 * turn stream.
 *
 * A command-line tool that is about to do something the developer will feel
 * — an app-test run that seizes the screen is the case this was built for —
 * `POST`s to tugcast's `/api/ask` and blocks. That question lands on the
 * session's store as `pendingAsk`, and this renders it.
 *
 * ## Why it looks different from `PermissionDialog`
 *
 * Both compose `TugInlineDialog`, but they are not the same kind of thing and
 * must not be mistakable for one another. A permission prompt comes from the
 * assistant's own turn; this comes from any process that can reach loopback.
 * `/api/ask` is deliberately not dev-gated — a consent prompt that only works
 * on a dev build is no consent prompt — which means caller-supplied text is
 * reaching the user's Session card.
 *
 * So the caller gets `title`, `description`, and option labels, and nothing
 * else. The icon and the tone are the app's, and the title is rendered as a
 * plain string with no rich content from the wire. A question cannot dress
 * itself up as one of the app's own prompts. This raises the cost of
 * impersonation; it does not authenticate anyone — loopback is still the
 * actual trust boundary.
 *
 * The statement of where the question came from is the dialog root's
 * `aria-description` rather than a rendered line. It could only ever read
 * "Requested by a command on this machine", so on screen it spent a row to
 * say nothing; a screen reader and the accessibility inspector still get it.
 *
 * ## Card-modal, like its siblings
 *
 * This is a card-modal inline dialog ([P16]): a trapped focus mode owns the
 * keyboard while it is up, Tab cycles only its own controls, Escape declines,
 * and the card content around it is scrimmed ([P19] — driven by the mount
 * site's `data-inline-dialog-pending`, which `inlineDialogPending` in
 * `session-card.tsx` sets off the snapshot's `pendingAsk`).
 *
 * While it is up the session reads **Awaiting** in the Z2 STATE cell and in the
 * Cards card session row, the same as the permission and question dialogs. Those two
 * get there through the reducer's `phase`; this one cannot (it belongs to no
 * turn), so it reaches the indicator through `sessionSessionPhaseKey`'s own
 * `pendingAsk` axis — see `session-phase-visual.ts`.
 *
 * Modality is not decoration here. Without the trap the prompt entry keeps the
 * caret, and `TugTextEditor`'s Return defers to whatever default button the
 * responder chain holds in its pane — which would be this dialog's own.
 * A developer typing a prompt and pressing Return would answer a question they
 * were not looking at, with the preselected option, and lose the submit. The
 * trap plus the entry stand-down is what makes Return mean one thing at a time.
 *
 * ## Two shapes
 *
 * A two-option question — the app-test case — is a header row and nothing
 * else: the declining option and the affirming one as a button pair in the
 * frame's trailing cluster, which is `TugInlineDialog`'s own `"header"`
 * layout. Three or more options keep the stacked radio shape, because eight
 * buttons on a row is not a shape and `/api/ask` allows up to eight.
 *
 * In the radio shape the options are a `TugRadioGroup` in the body rather
 * than `TugInlineDialog`'s own `options` prop: that prop renders
 * `TugDialogButton` rows, which carry no focus registration and are reachable
 * only by mouse. `PermissionDialog` makes the same substitution for the same
 * reason.
 *
 * ## Selection
 *
 * The safest option is preselected and seeded as the key view, so answering is
 * one keystroke and a reflexive Return never seizes the screen. Callers order
 * options with the declining one last; that is what Escape chooses, and what
 * the store falls back to when a question cannot be shown at all.
 *
 * ## The countdown
 *
 * A question that carries `unattendedChoice` is not asking permission — it is
 * offering a chance to intervene. Going ahead is the honest default there, and
 * a dialog that waited forever for a developer who has left the room would
 * strand the work it was being polite about. So the dialog counts
 * `countdownSecs` down in plain sight and commits when it reaches zero.
 *
 * What makes that safe to leave running is that the control at rest shows
 * what will happen. The two shapes reach it differently.
 *
 * In the **radio shape** the count commits the *selected* option: it decides
 * *when*, never *what*, so moving the selection to "skip" and walking away
 * skips. Touching the selection re-arms the clock, so a developer mid-decision
 * gets the full duration back from their last keystroke rather than being
 * timed out mid-thought.
 *
 * In the **button shape** there is no selection to move, so the count commits
 * `unattendedChoice` exactly, and skipping means saying so. What carries the
 * old guarantee is the default ring: it rests on `unattendedChoice` when the
 * caller set one and on the declining option when they did not, Return
 * presses that button, and Escape answers with the declining option. So the
 * ring is the whole of the preselection, and a button showing the ring says
 * what zero will do as plainly as a checked radio did.
 *
 * The tick writes into the DOM through a ref ([L06]) — a modal dialog has no
 * business re-rendering its whole subtree once a second — and the remaining
 * seconds live in a ref, never in state ([L24]).
 *
 * What the count looks like differs by shape. The radio shape says it in a
 * sentence under the options. The button shape has no room for one and does
 * not need it: the count is a rule along the frame's bottom edge, draining
 * left-anchored from full width to zero, and that is the whole of its
 * appearance — no numeral, no tint change as it runs out, no pulse. The
 * number itself stays in `data-remaining` and in the rule's `progressbar`
 * value, so leaving the screen is not leaving the accessibility tree.
 *
 * **Laws:** [L24] — `selectedOption` is a pre-commit draft owned by this
 * component and never leaves it; the question itself is local data on the
 * session store, read through `useSyncExternalStore` by the mount site ([L02]).
 * [L06] — tone and icon tint are CSS, not React state. [L11] — the radio group
 * is a control; its selection arrives through the responder chain.
 *
 * @module components/tugways/chrome/session-app-test-ask-dialog
 */

import "./session-app-test-ask-dialog.css";

import React from "react";
import { TerminalSquare } from "lucide-react";

import { TugInlineDialog } from "@/components/tugways/tug-inline-dialog";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugRadioGroup, TugRadioItem } from "@/components/tugways/tug-radio-group";
import { useFocusTrap } from "@/components/tugways/use-focus-trap";
import { useInlineDialogScope } from "@/components/tugways/use-inline-dialog-scope";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { useSpatialOrder } from "@/components/tugways/use-spatial-order";
import type { SpatialOrder } from "@/components/tugways/spatial-order";
import type { PendingAsk } from "@/lib/code-session-store/types";

export interface AppTestAskDialogProps {
  /** The live question. */
  ask: PendingAsk;
  /** Answer it and release the blocked caller. */
  onRespond: (choice: string) => void;
}

const CONFIRM_FOCUS_ORDER = 0;
const OPTIONS_FOCUS_ORDER = 1;
const DECLINE_FOCUS_ORDER = 2;

/**
 * Where the question came from. Never a rendered row — it could only ever say
 * this — but the dialog root's accessible description, so the statement stays
 * available to a screen reader without spending a line of height.
 */
const PROVENANCE = "Requested by a command on this machine";

/**
 * Whether this question renders as a button pair rather than a radio stack.
 *
 * Exactly two options is the app-test shape, and a pair is what a header row
 * can hold. `/api/ask` allows up to eight, and eight buttons on a row is not a
 * shape — so three or more keep the stack.
 */
function isButtonShape(ask: PendingAsk): boolean {
  return ask.options.length === 2;
}

/** The affirming option of a two-option question: callers put it first. */
function affirmingOption(options: ReadonlyArray<{ value: string }>): string {
  return options.length > 0 ? options[0].value : "";
}

/**
 * The option the dialog rests on — the radio shape's opening selection, and
 * the button shape's default ring.
 *
 * A countdown question starts on the answer it will commit — the preselection
 * and the count must never disagree. Otherwise it is the last option, which
 * callers reserve for declining: erring toward "do less" is the whole point of
 * a consent prompt.
 *
 * A caller's `unattendedChoice` is only honoured when it names an option they
 * actually offered. One that does not would leave the ring on nothing at all,
 * which in the button shape is the whole of the preselection.
 */
function restingOption(ask: PendingAsk): string {
  const { unattendedChoice, options } = ask;
  if (
    unattendedChoice !== null &&
    options.some((option) => option.value === unattendedChoice)
  ) {
    return unattendedChoice;
  }
  return decliningOption(options);
}

/** The option Escape answers with: always the declining one, countdown or not. */
function decliningOption(options: ReadonlyArray<{ value: string }>): string {
  return options.length > 0 ? options[options.length - 1].value : "";
}

/** The countdown line, rebuilt each tick. */
function countdownText(remaining: number): string {
  return `Continues with the selected option in ${remaining}s`;
}

/**
 * Write the count into the DOM.
 *
 * In the button shape the count is a rule draining along the frame's bottom
 * edge, so what is written is the fill's width — plus `data-remaining` and the
 * progressbar's value on the rule itself, because the number left the screen
 * and must not have left the accessibility tree with it. The radio shape has
 * no fill and keeps its sentence.
 *
 * `fraction` is the raw millisecond remainder rather than `remaining / total`:
 * the rule drains at the tick's own resolution instead of stepping once a
 * second, while the number stays the whole second a reader would say.
 *
 * Called from the tick and from the re-arm, never through state ([L06],
 * [L24]).
 */
function writeCountdown(
  el: HTMLDivElement | null,
  fill: HTMLDivElement | null,
  remaining: number,
  fraction: number,
): void {
  if (el === null) return;
  if (fill === null) {
    el.textContent = countdownText(remaining);
    return;
  }
  fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  el.dataset.remaining = String(remaining);
  el.setAttribute("aria-valuenow", String(remaining));
  el.setAttribute("aria-valuetext", `${remaining}s`);
}

export const AppTestAskDialog: React.FC<AppTestAskDialogProps> = ({
  ask,
  onRespond,
}) => {
  const focusGroup = React.useId();

  // Keyed on requestId so a second question replaces the first's selection
  // instead of inheriting it.
  const [selectedOption, setSelectedOption] = React.useState<string>(() =>
    restingOption(ask),
  );
  const lastRequestId = React.useRef(ask.requestId);
  if (lastRequestId.current !== ask.requestId) {
    lastRequestId.current = ask.requestId;
    setSelectedOption(restingOption(ask));
  }

  const buttonShape = isButtonShape(ask);
  // The button shape's default ring, which is the whole of its preselection:
  // the ringed button is what Return presses and what the count commits.
  const ringedValue = restingOption(ask);

  const handleConfirm = React.useCallback(() => {
    onRespond(selectedOption);
  }, [onRespond, selectedOption]);

  // The button shape has no selection to read, so `Run` answers with the
  // affirming option itself.
  const handleRun = React.useCallback(() => {
    onRespond(affirmingOption(ask.options));
  }, [onRespond, ask.options]);

  // Escape / Cmd-. answer with the declining option rather than dismissing.
  // There is no dismiss to offer: a process is blocked on this, and closing the
  // dialog without answering would leave it blocked with nothing on screen.
  const handleDecline = React.useCallback(() => {
    onRespond(decliningOption(ask.options));
  }, [onRespond, ask.options]);

  // What the count will commit. The button shape has no selection to move, so
  // it is the resting option itself — `unattendedChoice` exactly, when the
  // caller set one. The radio shape's is whatever is selected, which is what
  // re-arming on a keystroke exists for.
  //
  // The countdown reads these rather than closing over them, so a re-render —
  // a selection change, a new `onRespond` identity — never restarts the clock.
  const commitRef = React.useRef(selectedOption);
  commitRef.current = buttonShape ? ringedValue : selectedOption;
  const respondRef = React.useRef(onRespond);
  respondRef.current = onRespond;

  // When the count runs out, in `Date.now()` terms. Local data ([L24]): the
  // remaining seconds are DOM text, not state, so moving this moves nothing
  // React can see.
  const deadlineRef = React.useRef<number | null>(null);
  const countdownElRef = React.useRef<HTMLDivElement | null>(null);
  const countdownFillRef = React.useRef<HTMLDivElement | null>(null);

  const { countdownSecs } = ask;

  /** Give the developer the full duration back from their last keystroke. */
  const rearmCountdown = React.useCallback(() => {
    if (countdownSecs === null) return;
    deadlineRef.current = Date.now() + countdownSecs * 1000;
    writeCountdown(
      countdownElRef.current,
      countdownFillRef.current,
      countdownSecs,
      1,
    );
  }, [countdownSecs]);

  const handleSelect = React.useCallback(
    (next: string) => {
      setSelectedOption(next);
      rearmCountdown();
    },
    [rearmCountdown],
  );

  React.useEffect(() => {
    if (countdownSecs === null) return undefined;
    deadlineRef.current = Date.now() + countdownSecs * 1000;
    const tick = (): void => {
      const deadline = deadlineRef.current;
      if (deadline === null) return;
      // Ceil so the line reads the caller's own duration for a full second
      // before it says one less, and 0 is only ever shown at the commit.
      const msLeft = deadline - Date.now();
      const remaining = Math.max(0, Math.ceil(msLeft / 1000));
      writeCountdown(
        countdownElRef.current,
        countdownFillRef.current,
        remaining,
        countdownSecs > 0 ? msLeft / (countdownSecs * 1000) : 0,
      );
      if (remaining <= 0) {
        window.clearInterval(timer);
        respondRef.current(commitRef.current);
      }
    };
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
    // Re-armed by `rearmCountdown` through the ref; only a different question
    // (or a different duration) starts a new clock.
  }, [ask.requestId, countdownSecs]);

  // The engine-side trap. While it is up the Tab walk services only this
  // dialog's focusables, and the key view that was current when it opened is
  // restored on close.
  const { FocusModeScope, scopeId } = useFocusTrap({
    active: true,
    onEscapeDismiss: handleDecline,
  });

  // Two shapes, two orders. The button pair is one closed horizontal ring, so
  // Left and Right walk between Skip and Run and neither end beeps. The radio
  // shape keeps its closed vertical loop between the single action and the
  // option group, so no arrow dead-ends: Down or Up from Continue drops into
  // the options, Up from the top of the options returns to Continue. The
  // options are the group's delegated 1D cursor, not ring nodes.
  const confirmKey = `${focusGroup}:${CONFIRM_FOCUS_ORDER}`;
  const optionsKey = `${focusGroup}:${OPTIONS_FOCUS_ORDER}`;
  const declineKey = `${focusGroup}:${DECLINE_FOCUS_ORDER}`;
  const spatialOrder = React.useMemo<SpatialOrder>(
    () =>
      buttonShape
        ? {
            rings: [
              {
                axis: "horizontal",
                nodes: [declineKey, confirmKey],
                closed: true,
              },
            ],
          }
        : {
            rings: [],
            seams: [
              { from: confirmKey, direction: "down", to: optionsKey },
              { from: confirmKey, direction: "up", to: optionsKey },
              { from: optionsKey, direction: "up", to: confirmKey },
            ],
          },
    [buttonShape, confirmKey, declineKey, optionsKey],
  );
  useSpatialOrder(scopeId, spatialOrder);

  // `CANCEL_DIALOG` responder (Escape / Cmd-. → decline) plus the key-view seed
  // onto Continue, so the dialog opens with Return's home ringed and the whole
  // dialog scrolled into view. `attachRoot` wires the responder onto the outer
  // element, the ancestor of every control.
  const { attachRoot, responderId: dialogResponderId } = useInlineDialogScope({
    active: true,
    // Return presses the ringed button, so the key view opens on it. In the
    // radio shape that is always the single action.
    defaultFocusKey:
      buttonShape && ringedValue === decliningOption(ask.options)
        ? declineKey
        : confirmKey,
    onCancel: handleDecline,
  });

  // The options are a controlled radio group whose selection arrives through
  // the responder chain ([L11]). Its `parentId` is the dialog's cancel
  // responder, so an Escape while the radio holds the key view walks
  // `CANCEL_DIALOG` up to the decline instead of escaping past the dialog.
  const radioSenderId = React.useId();
  const { ResponderScope: OptionsResponderScope, responderRef: optionsResponderRef } =
    useResponderForm({
      selectValue: { [radioSenderId]: handleSelect },
      parentId: dialogResponderId,
    });

  return (
    <FocusModeScope>
      <div
        ref={attachRoot}
        className="session-app-test-ask-dialog"
        data-slot="session-app-test-ask-dialog"
        aria-description={PROVENANCE}
      >
        {buttonShape ? (
          // No `description`, no children, no `options` — which is what makes
          // the primitive take its own `"header"` layout. Passing any of them
          // as `null` would not: the frame reads the rendered rows, and a
          // children array of nulls is still an array.
          <TugInlineDialog
            className="session-app-test-ask-dialog-frame"
            icon={<TerminalSquare />}
            iconRole="caution"
            title={ask.title}
            actions={
              <>
                <TugPushButton
                  emphasis="outlined"
                  role="action"
                  size="xs"
                  focusGroup={focusGroup}
                  focusOrder={DECLINE_FOCUS_ORDER}
                  persistentDefaultRing={ringedValue === ask.options[1].value}
                  onClick={handleDecline}
                >
                  {ask.options[1].label}
                </TugPushButton>
                <TugPushButton
                  emphasis="primary"
                  role="action"
                  size="xs"
                  focusGroup={focusGroup}
                  focusOrder={CONFIRM_FOCUS_ORDER}
                  persistentDefaultRing={ringedValue === ask.options[0].value}
                  onClick={handleRun}
                >
                  {ask.options[0].label}
                </TugPushButton>
                {countdownSecs !== null ? (
                  // Inside the frame's own subtree rather than beside it, so
                  // the frame is the rule's containing block and the two
                  // genuinely share an edge. Absolutely positioned, so it
                  // costs the header row no layout — which a child of the
                  // frame's body would, by making the frame `"full"` again.
                  <div
                    ref={countdownElRef}
                    className="session-app-test-ask-dialog-countdown-rule"
                    data-slot="session-app-test-ask-dialog-countdown"
                    data-remaining={countdownSecs}
                    role="progressbar"
                    aria-label="Time remaining"
                    aria-valuemin={0}
                    aria-valuemax={countdownSecs}
                    aria-valuenow={countdownSecs}
                    aria-valuetext={`${countdownSecs}s`}
                  >
                    <div
                      ref={countdownFillRef}
                      className="session-app-test-ask-dialog-countdown-fill"
                    />
                  </div>
                ) : null}
              </>
            }
          />
        ) : (
          <TugInlineDialog
            icon={<TerminalSquare />}
            iconRole="caution"
            title={ask.title}
            description={ask.description ?? undefined}
            actions={
              <TugPushButton
                emphasis="primary"
                role="action"
                size="xs"
                focusGroup={focusGroup}
                focusOrder={CONFIRM_FOCUS_ORDER}
                persistentDefaultRing
                onClick={handleConfirm}
              >
                Continue
              </TugPushButton>
            }
          >
            <OptionsResponderScope>
              <div
                ref={optionsResponderRef as (el: HTMLDivElement | null) => void}
                className="session-app-test-ask-dialog-options"
              >
                <TugRadioGroup
                  value={selectedOption}
                  senderId={radioSenderId}
                  size="md"
                  orientation="vertical"
                  aria-label={ask.title}
                  focusGroup={focusGroup}
                  focusOrder={OPTIONS_FOCUS_ORDER}
                >
                  {ask.options.map((option) => (
                    <TugRadioItem
                      key={option.value}
                      value={option.value}
                      description={option.description}
                    >
                      {option.label}
                    </TugRadioItem>
                  ))}
                </TugRadioGroup>
              </div>
            </OptionsResponderScope>
            {countdownSecs !== null ? (
              <div
                ref={countdownElRef}
                className="session-app-test-ask-dialog-countdown"
                data-slot="session-app-test-ask-dialog-countdown"
              >
                {countdownText(countdownSecs)}
              </div>
            ) : null}
          </TugInlineDialog>
        )}
      </div>
    </FocusModeScope>
  );
};
