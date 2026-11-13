/**
 * session-name-editor — the Session card masthead's name, editable in place.
 *
 * Two parts, both mounted by `SessionIdentityRow` on the one surface that asks
 * for them (the masthead): {@link SessionNameEditor}, the field that stands
 * where the name stood while the card's rename mode is on, and
 * {@link SessionNameRenameButton}, the pencil that follows the name and opens
 * it. Whether the mode is on is `sessionRenameModeStore`'s; these components
 * only close it.
 *
 * **The field's contract.** Return commits, Escape cancels, and clicking away
 * commits. A blank commit clears the name. A commit that changes nothing sends
 * nothing: a click-away from an untouched field is not a rename, and it should
 * not raise a bulletin saying one happened.
 *
 * **It claims no success on the gesture.** The commit is the card's own —
 * the optimistic name write, the settle waiter, the restore on refusal and the
 * bulletin on the ack — reached through the store's committer, because the
 * bulletin lives inside the card host and the masthead is chrome above it.
 *
 * **The keyboard is taken through the engine and handed back.** The masthead
 * is outside the card host, so the field is authored into the card's focus
 * context by hand (`CardIdContext`) and takes the key view by placement, never
 * a raw focus write. What the card's focus destination was when the field
 * opened is kept, and placed again when editing ends — the composer on an open
 * card, the fold glyph on a folded one — so the editor needs to know nothing
 * about either.
 *
 * **Escape is declared the field's own** (`focusBehavior.captures`), the same
 * mechanism the Cards card's workspace rename uses: the engine arbitrates
 * Escape for the deck, and a field that says nothing never sees the press.
 *
 * **Uncontrolled.** The draft lives in the DOM, so a keystroke re-renders none
 * of the chrome the field sits in.
 *
 * Laws: [L02] rename mode is read by the row through `useSyncExternalStore`;
 *       [L03] the keyboard is taken in a layout effect, after `TugInput`'s own
 *       registration; [L06] the pencil's reveal is a DOM attribute and CSS; [L07] the
 *       seed and the prior focus target are read once, at open; [L11] the
 *       field is a control and the card owns the commit; [L20] the composed
 *       input and button keep their own tokens; [L31] a commit with no
 *       committer registered still renames.
 *
 * @module components/tugways/session-name-editor
 */

import "./session-name-editor.css";

import { Pencil } from "lucide-react";
import React from "react";

import { sendToCardContent } from "@/command-dispatch";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import type { FocusTarget, KeyViewBehavior } from "@/components/tugways/focus-manager";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugInput } from "@/components/tugways/tug-input";
import { useFocusManager } from "@/components/tugways/use-focusable";
import { CardIdContext } from "@/lib/card-id-context";
import { commitSessionRename } from "@/lib/session-rename-commit";
import {
  sessionRenameCommit,
  sessionRenameModeStore,
} from "@/lib/session-rename-mode-store";

/** The field's focus group — its own, so it collides with no group a card names. */
export const SESSION_RENAME_FOCUS_GROUP = "session-rename";
/** The field's order within {@link SESSION_RENAME_FOCUS_GROUP}. */
export const SESSION_RENAME_FOCUS_ORDER = 0;
/** The stable `group:order` key a placement lands the keyboard on the field by. */
export const SESSION_RENAME_FOCUS_KEY = `${SESSION_RENAME_FOCUS_GROUP}:${SESSION_RENAME_FOCUS_ORDER}`;

/** Whether `target` is this field's own placement. */
function isRenameFieldTarget(target: FocusTarget): boolean {
  return target.kind === "focus-key" && target.focusKey === SESSION_RENAME_FOCUS_KEY;
}

export interface SessionNameEditorProps {
  /** The card whose session is being renamed, and whose focus context the field joins. */
  cardId: string;
  /** The session's custom name, or null for a session that has none. */
  name: string | null;
  /**
   * What an unnamed session's title shows — its `project/callsign`. It is the
   * placeholder rather than the seed: a minted handle is not a name to edit.
   */
  placeholder: string;
}

/** The inline field. Mounted only while the card's rename mode is on. */
export function SessionNameEditor({
  cardId,
  name,
  placeholder,
}: SessionNameEditorProps): React.ReactElement {
  return (
    // The masthead renders above the card host, so the context every other
    // stop reads its card from is absent here; without it the field would
    // register into the default focus context rather than this card's.
    <CardIdContext value={cardId}>
      <SessionNameField cardId={cardId} name={name} placeholder={placeholder} />
    </CardIdContext>
  );
}

function SessionNameField({
  cardId,
  name,
  placeholder,
}: SessionNameEditorProps): React.ReactElement {
  const focusManager = useFocusManager();
  const fieldRef = React.useRef<HTMLInputElement | null>(null);
  // Set by whichever ending ran first, so the blur an ending causes cannot
  // run a second one.
  const ended = React.useRef(false);
  // The name as it stood when the field opened: the seed, and what a commit
  // is compared against.
  const opened = React.useRef(name);
  // Where the card kept the keyboard before the field took it.
  const priorTarget = React.useRef<FocusTarget | null>(null);
  // The pending blur-commit (see `onBlur`), cleared on unmount so a field the
  // card took down cannot land a rename a turn later.
  const commitTimer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    },
    [],
  );

  // Take the keyboard through the engine, then open with the whole name
  // selected so typing replaces it. `TugInput` registers the stop in its own
  // layout effect, which React runs before this one.
  React.useLayoutEffect(() => {
    if (focusManager !== null) {
      const prior = focusManager.contextFor(cardId).target();
      priorTarget.current = isRenameFieldTarget(prior) ? null : prior;
      focusManager.place(
        cardId,
        { kind: "focus-key", focusKey: SESSION_RENAME_FOCUS_KEY },
        { modality: "keyboard" },
      );
    }
    fieldRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- taken once, at open
  }, []);

  // Hand the keyboard back to where the card kept it. Only while the card's
  // destination is still this field: a click-away that placed the keyboard
  // somewhere else has already said where it goes.
  const returnKeyboard = (): void => {
    if (focusManager !== null) {
      if (!isRenameFieldTarget(focusManager.contextFor(cardId).target())) return;
      const prior = priorTarget.current;
      if (prior !== null && prior.kind !== "none") {
        focusManager.place(cardId, prior, {
          modality:
            prior.kind === "focusable" || prior.kind === "focus-key"
              ? "keyboard"
              : "pointer",
        });
        return;
      }
    }
    sendToCardContent(cardId, TUG_ACTIONS.FOCUS_PROMPT);
  };

  const end = (commit: boolean): void => {
    if (ended.current) return;
    ended.current = true;
    if (commit) {
      const verdict = sessionRenameCommit(
        opened.current,
        fieldRef.current?.value ?? "",
      );
      if (verdict.rename && !sessionRenameModeStore.commit(cardId, verdict.name)) {
        // No card registered a commit — rename all the same, without the
        // card's bulletin, rather than drop the gesture.
        commitSessionRename(cardId, verdict.name, () => null);
      }
    }
    // Before the mode closes: the placement moves the keyboard off a field
    // that is still mounted, rather than off one already gone.
    returnKeyboard();
    sessionRenameModeStore.end(cardId);
  };

  const focusBehavior = React.useCallback(
    (): KeyViewBehavior => ({
      container: "none",
      captures: (key) => key.key === "Escape",
    }),
    [],
  );

  return (
    <TugInput
      ref={fieldRef}
      size="sm"
      focusGroup={SESSION_RENAME_FOCUS_GROUP}
      focusOrder={SESSION_RENAME_FOCUS_ORDER}
      focusBehavior={focusBehavior}
      className="session-name-editor"
      data-slot="session-name-editor"
      data-testid="session-name-editor"
      aria-label="Session name"
      defaultValue={opened.current ?? ""}
      placeholder={placeholder}
      // The title bar is a gesture surface; a press or a keystroke aimed at
      // the field is the field's.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          end(true);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          end(false);
          return;
        }
        e.stopPropagation();
      }}
      onBlur={() => {
        if (ended.current) return;
        // A blur is a click-away only if it STAYS one: a click inside the
        // field's own text can blur it for a moment while the gesture
        // activates the card and the engine grants the text surface back.
        // One turn's delay tells the two apart.
        const el = fieldRef.current;
        commitTimer.current = window.setTimeout(() => {
          commitTimer.current = null;
          if (ended.current) return;
          if (el !== null && document.activeElement === el) return;
          end(true);
        }, 0);
      }}
    />
  );
}

export interface SessionNameRenameButtonProps {
  /** Open the surface's inline name editor. */
  onRename: () => void;
}

/**
 * The pencil after the name, and the word Rename after the pencil. The pencil
 * is a `TugIconButton`, which refuses first responder on click and is not the
 * pane's grab handle, so a press on it neither takes the keyboard from the
 * composer nor begins a drag. The word is a second target for the same act,
 * outside the button so the button's rollover box stays the icon's own.
 *
 * It is revealed while the pointer is on the name or on the pencil itself, and
 * the reveal is read from `pointerenter`/`pointerleave` rather than the
 * `:hover` pseudo-class — the same rule the pane's own rollup follows, because
 * a pseudo-class is decided by WebKit's hit-testing against the physical
 * cursor. The listeners write one attribute on the pencil's own span and
 * nothing re-renders ([L06]).
 */
export function SessionNameRenameButton({
  onRename,
}: SessionNameRenameButtonProps): React.ReactElement {
  const spanRef = React.useRef<HTMLSpanElement | null>(null);
  React.useLayoutEffect(() => {
    const span = spanRef.current;
    // The name is the run the pencil follows.
    const name = span?.previousElementSibling;
    if (span === null || !(name instanceof HTMLElement)) return;
    const reveal = (): void => span.setAttribute("data-revealed", "");
    const conceal = (e: PointerEvent): void => {
      // Travelling between the name and the pencil is not leaving.
      const to = e.relatedTarget;
      if (to instanceof Node && (span.contains(to) || name.contains(to))) return;
      span.removeAttribute("data-revealed");
    };
    const parts = [name, span];
    for (const el of parts) {
      el.addEventListener("pointerenter", reveal);
      el.addEventListener("pointerleave", conceal);
    }
    return () => {
      for (const el of parts) {
        el.removeEventListener("pointerenter", reveal);
        el.removeEventListener("pointerleave", conceal);
      }
    };
  }, []);
  return (
    <span
      ref={spanRef}
      // The second class is the pane's: it puts the pencil under the title-bar
      // cluster's own palette, so it reads as one of the bar's controls.
      className="session-name-rename tug-pane-title-bar-inline-control"
      data-slot="session-name-rename"
    >
      <TugIconButton
        // The cluster's own size, so the glyph matches the controls at the
        // bar's right.
        size="sm"
        icon={<Pencil />}
        // Chrome, like the masthead's other buttons — never a Tab stop.
        tabIndex={-1}
        aria-label="Rename session"
        data-testid="session-name-rename"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e?.stopPropagation();
          onRename();
        }}
      />
      <span
        className="session-name-rename-label"
        // The button already names the act for assistive tech.
        aria-hidden="true"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onRename();
        }}
      >
        Rename
      </span>
    </span>
  );
}
