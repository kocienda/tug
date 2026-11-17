/**
 * explain-code-sheet.tsx — the Explain Code sheet: every form a diagram of
 * code can take, with a sample figure and the words that ask for it.
 *
 * Everything shown comes from the forms catalog through `diagram-forms-store`,
 * so this file names no form and a new one needs no change here. The first row
 * names no form and lets the question choose one, which is what the explain
 * skill does when it is given none. A diagram of a project exists only after
 * its code has been read, so every figure here is the form's sample, marked as
 * one, drawn still and without its keyed table. Explain… hands the row's form
 * to the card, which places the command in the composer with the caret where
 * the subject goes and leaves the send to the user.
 *
 * Compositional — composes `TugSheet` (via the card's shared `showSheet`),
 * `TugSheetScaffold`, `SheetNotice`, `ChartBlock` and `TugPushButton`;
 * composed children keep their own tokens ([L20]).
 *
 * Laws: [L02] the forms are read through `useSyncExternalStore`, [L06]
 *       appearance stays in CSS and a row's form is an attribute, [L16] every
 *       colour rule names its surface, [L19] the file pair, [L20] composed
 *       children keep tokens, [L27] the dispatch observer is released on
 *       unmount, [L30] the sheet is opened by a registry command and closed by
 *       the same one, [L33] a read that fails says so in a notice.
 * Decisions: [D15] pane sheets are overlays.
 *
 * @module components/tugways/cards/explain-code-sheet
 */

import { SheetNotice } from "./sheet-header";
import "./explain-code-sheet.css";

import {
  ArrowLeftRight,
  CircleDot,
  Layers,
  ListTree,
  Shapes,
  SquareStack,
  WandSparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import React, { useCallback, useEffect, useRef } from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { ChartBlock } from "@/components/tugways/body-kinds/chart-block";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import { TugSheetScaffold } from "@/components/tugways/tug-sheet-scaffold";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { diagramForms, useDiagramForms, type DiagramForm } from "@/lib/diagram-forms-store";
import { MODAL_REST_LINE } from "./modal-rest-line";

/** The card command behind the menu row and the chord. `/explain` stays the skill's. */
export const EXPLAIN_CODE_COMMAND = "explain-code";

/** The command Explain… places: the name the popup composes for the `/explain` skill. */
export const EXPLAIN_SKILL_COMMAND = "tugplug:explain";

/** What the sheet resolves with for the row that names no form. */
const NO_FORM = "";

/**
 * The text that closes an explain request naming `form`, placed behind the
 * caret so the subject is typed before it; empty when the question chooses.
 */
export function explainRequestTail(form: string | null): string {
  return form === null ? "" : ` as ${form}`;
}

/**
 * Every closing a placed request may already end with, one per form the list
 * names, so a second Explain… swaps the form rather than adding one, and the
 * row that names no form takes it away.
 */
export function explainRequestTails(): string[] {
  return (diagramForms().forms ?? []).map((form) => explainRequestTail(form.name));
}

export interface UseExplainCodeSheetArgs {
  /** Place the explain command in the composer, unsent; `null` names no form. */
  placeForm: (form: string | null) => void;
  /** The card's shared sheet host (`useTugSheet().showSheet`). */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
}

export interface ExplainCodeSheetController {
  /** Present the sheet or, when it is the one showing, dismiss it. */
  openExplainCodeSheet: () => void;
}

export function useExplainCodeSheet({
  placeForm,
  showSheet,
}: UseExplainCodeSheetArgs): ExplainCodeSheetController {
  // The sheet host is single-slot, so its promise resolving is the authoritative
  // "no longer showing" signal, and what it resolves with is the form Explain… chose.
  const shownRef = useRef(false);
  const closeRef = useRef<(() => void) | null>(null);

  const openExplainCodeSheet = useCallback(() => {
    if (shownRef.current) {
      closeRef.current?.();
      return;
    }
    shownRef.current = true;
    void showSheet({
      title: "Explain Code",
      icon: <Shapes />,
      displayWidth: "xl",
      presentation: "rise",
      bottomAnchorSelector: MODAL_REST_LINE,
      content: (close) => <ExplainCodeSheetBody onClose={close} registerClose={closeRef} />,
    }).then((chosen) => {
      shownRef.current = false;
      closeRef.current = null;
      if (chosen !== undefined) placeForm(chosen === NO_FORM ? null : chosen);
    });
  }, [placeForm, showSheet]);

  return { openExplainCodeSheet };
}

interface ExplainCodeSheetBodyProps {
  onClose: (value?: string) => void;
  /** Hands this sheet's `close` back to the controller, for the chord's re-press. */
  registerClose: React.MutableRefObject<(() => void) | null>;
}

function ExplainCodeSheetBody({ onClose, registerClose }: ExplainCodeSheetBodyProps): React.ReactElement {
  const { forms, failure } = useDiagramForms();

  useEffect(() => {
    registerClose.current = () => onClose();
    return () => {
      registerClose.current = null;
    };
  }, [registerClose, onClose]);

  // The chord's second press. While a sheet is up there is no key card, so the
  // card cannot answer its own command, but the dispatch is still announced.
  const manager = useResponderChain();
  useEffect(() => {
    if (manager === null) return;
    return manager.observeDispatch((event) => {
      if (event.action !== TUG_ACTIONS.RUN_SLASH_COMMAND) return;
      const value = event.value as { name?: string } | undefined;
      if (value?.name === EXPLAIN_CODE_COMMAND) onClose();
    });
  }, [manager, onClose]);

  const doneFocusGroup = React.useId();
  useSeedKeyView(`${doneFocusGroup}:0`);

  let notice: string | null = null;
  if (forms === null) notice = failure !== null ? `Could not read the diagram forms: ${failure}` : "Reading the diagram forms…";
  else if (failure !== null) notice = `Could not refresh the diagram forms: ${failure}`;

  return (
    <TugSheetScaffold
      className="explain-code-sheet"
      footer={
        <div className="explain-code-sheet-footer">
          <TugPushButton
            size="sm"
            emphasis="primary"
            onClick={() => onClose()}
            data-testid="explain-code-done"
            focusGroup={doneFocusGroup}
            focusOrder={0}
          >
            Done
          </TugPushButton>
        </div>
      }
    >
      <div className="explain-code-sheet-body" data-slot="explain-code-sheet" data-testid="explain-code-sheet">
        <div className="explain-code-sheet-row" data-tugx-explain-form="">
          <div className="explain-code-sheet-title">
            <div className="explain-code-sheet-heading">
              <WandSparkles className="explain-code-sheet-icon" size={16} aria-hidden />
              <div className="explain-code-sheet-name" data-plain="">
                Let the question choose
              </div>
            </div>
          </div>
          <div className="explain-code-sheet-text">
            <div className="explain-code-sheet-shows">
              Name no form, and the explanation draws each part in the form that suits it.
            </div>
            <div className="explain-code-sheet-actions">
              <TugPushButton size="sm" emphasis="outlined" onClick={() => onClose(NO_FORM)} data-testid="explain-code-explain-any">
                Explain…
              </TugPushButton>
            </div>
          </div>
        </div>
        {notice !== null ? (
          <SheetNotice layout="line" className="explain-code-sheet-notice" role="status">
            {notice}
          </SheetNotice>
        ) : null}
        {forms !== null ? forms.map((form) => <FormRowView key={form.name} form={form} onExplain={onClose} />) : null}
      </div>
    </TugSheetScaffold>
  );
}

/** The icon for a catalog form. A form this does not know wears the plain figure. */
function formIcon(name: string): LucideIcon {
  switch (name) {
    case "flow":
      return Workflow;
    case "sequence":
      return ArrowLeftRight;
    case "layers":
      return Layers;
    case "stack":
      return SquareStack;
    case "states":
      return CircleDot;
    case "tree":
      return ListTree;
    default:
      return Shapes;
  }
}

function FormRowView({
  form,
  onExplain,
}: {
  form: DiagramForm;
  onExplain: (name: string) => void;
}): React.ReactElement {
  const Icon = formIcon(form.name);
  return (
    <div className="explain-code-sheet-row" data-tugx-explain-form={form.name}>
      <div className="explain-code-sheet-title">
        <div className="explain-code-sheet-heading">
          <Icon className="explain-code-sheet-icon" size={16} aria-hidden />
          <div className="explain-code-sheet-name">{form.name}</div>
        </div>
        <div className="explain-code-sheet-sample-mark">Sample</div>
      </div>
      <div className="explain-code-sheet-text">
        <div className="explain-code-sheet-shows">{form.shows}</div>
        {form.said.length > 0 ? (
          <div className="explain-code-sheet-said">Also said: {form.said.join(", ")}</div>
        ) : null}
        <div className="explain-code-sheet-example">
          For example: <span className="explain-code-sheet-ask">{form.ask}</span>
        </div>
        <div className="explain-code-sheet-actions">
          <TugPushButton
            size="sm"
            emphasis="outlined"
            onClick={() => onExplain(form.name)}
            data-testid={`explain-code-explain-${form.name}`}
          >
            Explain…
          </TugPushButton>
        </div>
      </div>
      <div className="explain-code-sheet-figure">
        <ChartBlock source={JSON.stringify(form.sample)} layers="diagram" thumbnail />
      </div>
    </div>
  );
}
