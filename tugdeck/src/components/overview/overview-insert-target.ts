/**
 * The Overview composer as a {@link PromptInsertTarget} — what makes
 * `Insert Atom into Prompt` a real item in the Overview's menu rather than
 * one filtered out for want of a session.
 *
 * A module-level singleton rather than a hook result, because the two
 * surfaces that send into the composer are not its children: the row menu is
 * built per post cell and the click layer is attached to the scroller, while
 * the composer sits at the bottom of the rail. The composer registers its
 * editor delegate here on mount and clears it on unmount; everything else
 * reaches the composer through this object.
 *
 * **Park until mounted.** The Session's store parks a pending insert in its
 * snapshot and `TugPromptEntry` drains it when it mounts, so a gesture made
 * against an unmounted composer is never silently dropped. This is that
 * semantic, spelled as a queue: an insert with no delegate is held and
 * replayed in order the moment one binds. The queue is capped — a target
 * nobody ever binds is a rail that is not showing, and holding an unbounded
 * history of inserts for it would only mean a flood when it finally does.
 *
 * **Raising is the focus engine's own stop, not a bare `focus()`.** The
 * Session's raise activates the annotation's card; the Overview is a sidebar
 * rail that is already showing when its menu is open, so the corresponding
 * gesture is putting the caret in the field. Placed through
 * `FocusManager.place` on the composer's focus key, which is what routes the
 * keyboard `dom-granted` to the CM6 caret and paints the ring the same way
 * every other arrival does — and which arms the engine's own late-mount
 * realization when the field is not rendered yet.
 *
 * @module components/overview/overview-insert-target
 */

import { applyAppendInsertion } from "@/components/tugways/tug-prompt-entry";
import { getFocusManager } from "@/components/tugways/focus-manager";
import type { TugTextEditorDelegate } from "@/components/tugways/tug-text-editor";
import {
  dropOffsetAtCoords,
  insertSubstrateAt,
} from "@/components/tugways/tug-text-editor/drop-extension";
import { getDeckStore } from "@/lib/deck-store-registry";
import { OVERVIEW_CARD_ID } from "@/lib/overview-card-id";
import type { AtomSegment } from "@/lib/tug-text-types";
import type {
  PromptInsertPoint,
  PromptInsertTarget,
} from "@/lib/prompt-insert-target";

/**
 * The composer's stop in the focus engine, as the engine addresses one:
 * `"<group>:<order>"`. The field is `focusOrder={0}` of the card's group, and
 * the two are written here together so a change to either is a change to a
 * pair rather than to a string somebody has to remember.
 */
export const OVERVIEW_COMPOSER_FOCUS_KEY = "overview-card:0";

/**
 * The Overview card's live id, or `null` when the rail is not showing.
 *
 * {@link OVERVIEW_CARD_ID} is the card's **componentId** — its entry in the
 * registry — and the focus engine keys its contexts by the **card id**, which
 * the deck mints fresh (`crypto.randomUUID()`) every time the rail is shown.
 * Handing the engine the componentId names a context nothing ever registers a
 * focusable into, so the placement resolves against an empty context and
 * paints nothing. Read live, because the id does not survive a hide.
 */
function overviewCardId(): string | null {
  const cards = getDeckStore()?.getSnapshot().cards ?? [];
  return cards.find((c) => c.componentId === OVERVIEW_CARD_ID)?.id ?? null;
}

/**
 * How many inserts are held for a composer that has not mounted. Two or three
 * is the realistic ceiling (a user working a closed rail's menu); the cap is
 * here so a pathological caller cannot grow the queue without bound.
 */
const MAX_PARKED = 16;

class OverviewInsertTarget implements PromptInsertTarget {
  private delegate: TugTextEditorDelegate | null = null;
  private parked: Array<(delegate: TugTextEditorDelegate) => void> = [];

  /** Called by the composer's editor ref callback, with `null` on unmount. */
  bind(delegate: TugTextEditorDelegate | null): void {
    this.delegate = delegate;
    if (delegate === null || this.parked.length === 0) return;
    const held = this.parked;
    this.parked = [];
    for (const run of held) run(delegate);
  }

  insertAtom(segment: AtomSegment): void {
    this.run((delegate) => {
      delegate.insertAtom(segment);
      delegate.focus();
    });
  }

  insertText(
    text: string,
    atoms: ReadonlyArray<AtomSegment>,
    at: PromptInsertPoint | null,
  ): void {
    this.run((delegate) => {
      const view = delegate.view();
      if (view === null) return;
      const offset = at !== null ? dropOffsetAtCoords(view, at.x, at.y) : null;
      let from: number;
      let insert: string;
      if (offset !== null) {
        from = offset;
        insert = text;
      } else {
        // The append rule the Session entry uses for a jot with no resolvable
        // drop point: an empty composer takes the text as-is, a draft in
        // progress gets it on its own line and is never clobbered.
        const appended = applyAppendInsertion(text, {
          length: view.state.doc.length,
          isEffectivelyEmpty: view.state.doc.length === 0,
        });
        from = appended.from;
        insert = appended.insert;
      }
      // The substrate, not the string: a chip carried in arrives as that chip.
      // `insert` may lead with the append rule's newline, so the atoms hang
      // off the placeholders in `insert` rather than in `text`.
      insertSubstrateAt(view, from, insert, atoms);
      view.dispatch({ scrollIntoView: true });
    });
  }

  raise(): void {
    const cardId = overviewCardId();
    // No card is the rail put away, and a placement into a card that is not
    // there is not a thing to fake. The insert itself still parks, so showing
    // the rail again brings the caret with it.
    if (cardId === null) return;
    getFocusManager()?.place(
      cardId,
      { kind: "focus-key", focusKey: OVERVIEW_COMPOSER_FOCUS_KEY },
      { modality: "keyboard" },
    );
  }

  /** Run against the bound delegate, or park until one binds. */
  private run(op: (delegate: TugTextEditorDelegate) => void): void {
    const delegate = this.delegate;
    if (delegate !== null) {
      op(delegate);
      return;
    }
    if (this.parked.length >= MAX_PARKED) this.parked.shift();
    this.parked.push(op);
  }
}

let _target: OverviewInsertTarget | null = null;

/** The Overview composer's insert target. */
export function overviewInsertTarget(): PromptInsertTarget & {
  bind(delegate: TugTextEditorDelegate | null): void;
} {
  _target ??= new OverviewInsertTarget();
  return _target;
}
