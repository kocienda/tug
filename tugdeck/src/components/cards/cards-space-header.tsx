/**
 * cards-space-header.tsx — the WORKSPACE header row and the verbs it carries
 * ([P09], [P11], Spec S05).
 *
 * The outermost row of the Workspaces card, and it reads in TWO columns. The
 * leading one is the identity — the mark that says which workspace is on
 * screen, and the name — and it is what a reader scans a column of these rows
 * for. The trailing one is the tally: how many cards the workspace holds and
 * how many of its sessions are live, pipe-delimited in the tool-call block
 * header's own idiom, which is what a reader checks once they have found the
 * row. Click or Enter is the delegate's and on this row means "go there" —
 * `activate-space`, a no-op on the workspace already showing.
 *
 * **The three verbs have a visible door as well as a right-click.** They used
 * to be right-click-only, on the argument that a person makes a workspace
 * once and deletes one almost never, so the row's whole job in between is to
 * be read and travelled through. That argument holds for how OFTEN they are
 * reached and says nothing about whether they can be FOUND: a verb with no
 * visible door is a verb a person has to already know about ([B01]). So the
 * row carries a `···` trigger in its trailing cluster which opens the same
 * three-item menu the right-click opens — one menu, one item list, two ways
 * in. Making a workspace is not among them: a menu opened on a row is about
 * that row, and the card's `+` beside the filter field is the door for making
 * one.
 * They are ordinary table commands now rather than outside-the-table escapes,
 * because each takes an optional `spaceId` and means the active workspace
 * without one ([P02]).
 *
 * **The menu carries no responder of its own.** `TugEditorContextMenu`
 * dispatches each item to the responder that encloses it in the React tree,
 * and every one of those dispatches now travels the chain to its ROOT, which
 * is where the three verbs are answered ([P02]). Rename and Delete need this
 * card's surfaces, so the root hands them back through
 * `cardsSpaceVerbRequest` ([P03], [P08]). Either way nothing is held on a
 * cell, which is recycled as the list changes.
 *
 * Laws: [L02] every fact on the row comes from the data source's projection;
 * [L06] the active mark and the drop-target highlight are CSS on `data-*`;
 * [L19] the row composes `TugListRow` and the cue is a real `BlockFoldCue`;
 * [L24] the rename draft is the field's own while it is open.
 *
 * @module components/cards/cards-space-header
 */

import React from "react";
import { Eye, EyeClosed, MoreHorizontal } from "lucide-react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { TugBadge } from "@/components/tugways/tug-badge";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import {
  TugEditorContextMenu,
  type TugEditorContextMenuEntry,
} from "@/components/tugways/tug-editor-context-menu";
import { TugInput } from "@/components/tugways/tug-input";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugListRow } from "@/components/tugways/tug-list-row";
import type {
  TugListViewCellProps,
  TugListViewCellRenderer,
} from "@/components/tugways/tug-list-view";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";

import type { CardsDataSource } from "./cards-data-source";
import { CARDS_RENAME_FOCUS_ORDER, useCellContext } from "./cards-cell-context";

/**
 * The verbs menu for one workspace row.
 *
 * Every item names its workspace in its own `value`, so the card body answers
 * for the row the right-click landed on rather than for whatever the list
 * cursor happens to be sitting on. All three carry one, because all three are
 * about the row the menu was opened on — which is why New Workspace is not
 * among them: it has no row to be about, and the card's `+` beside the filter
 * field is its door.
 *
 * Delete on the only workspace is disabled and says why in its own label:
 * a disabled item takes no pointer events, so a `title` on one can never be
 * read ([L31]).
 */
export function useSpaceRowMenu(opts: {
  spaceId: string;
  name: string;
  spaceCount: number;
}): {
  menu: React.ReactNode;
  openMenuAt: (x: number, y: number) => void;
} {
  const { spaceId, name, spaceCount } = opts;
  const manager = useResponderChain();
  const [openAt, setOpenAt] = React.useState<{ x: number; y: number } | null>(
    null,
  );
  const closeMenu = React.useCallback(() => setOpenAt(null), []);

  const openMenuAt = React.useCallback(
    (x: number, y: number): void => {
      if (manager === null) return;
      setOpenAt({ x, y });
    },
    [manager],
  );

  const items = React.useMemo<TugEditorContextMenuEntry[]>(() => {
    const last = spaceCount <= 1;
    return [
      {
        action: TUG_ACTIONS.RENAME_SPACE,
        label: "Rename",
        value: { spaceId },
      },
      {
        action: TUG_ACTIONS.DUPLICATE_SPACE,
        label: "Duplicate",
        value: { spaceId },
      },
      {
        action: TUG_ACTIONS.DELETE_SPACE,
        label: last ? "Delete — the last workspace" : "Delete",
        disabled: last,
        value: { spaceId },
      },
    ];
  }, [spaceId, spaceCount]);

  const menu =
    manager === null ? null : (
      <span
        className="cards-space-verbs"
        data-slot="cards-space-verbs"
        aria-label={`Actions for workspace ${name}`}
      >
        <TugEditorContextMenu
          open={openAt !== null}
          x={openAt?.x ?? 0}
          y={openAt?.y ?? 0}
          items={items}
          onClose={closeMenu}
        />
      </span>
    );

  return { menu, openMenuAt };
}

/**
 * The inline rename field ([P11]).
 *
 * Keyed by workspace id at the call site, so opening a rename on a different
 * row starts from that row's name rather than inheriting the last one's draft.
 * Enter commits, Escape cancels, and a blur commits — the ordinary field
 * contract. The `cancelled` ref is what keeps Escape from committing through
 * the blur it causes.
 *
 * **Uncontrolled.** The draft lives in the DOM rather than in React state, so
 * the field does not re-render the row it sits in on every keystroke — a cell
 * inside a list whose data source is recomputing underneath it is the one
 * place a per-character render can cost the characters themselves.
 */
function SpaceRenameField({
  name,
  focusGroup,
  takeKeyboard,
  onCommit,
  onCancel,
}: {
  name: string;
  focusGroup: string;
  takeKeyboard: () => void;
  onCommit: (next: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const fieldRef = React.useRef<HTMLInputElement | null>(null);
  const cancelled = React.useRef(false);
  const draft = (): string => fieldRef.current?.value ?? name;
  // Take the keyboard through the engine, then open with the whole name
  // selected so typing replaces it. The order is load-bearing: the field is
  // registered by the layout effect inside `TugInput`, which React runs before
  // this one, and the placement is what routes keys to the DOM at all.
  React.useLayoutEffect(() => {
    takeKeyboard();
    const el = fieldRef.current;
    if (el === null) return;
    // `select()` rather than `setSelectionRange(0, …)`: the latter is reserved
    // for the three modules that RESTORE a selection, and this is an author's
    // opening selection rather than a restore.
    el.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <TugInput
      ref={fieldRef}
      size="sm"
      focusGroup={focusGroup}
      focusOrder={CARDS_RENAME_FOCUS_ORDER}
      className="cards-space-rename"
      data-testid="cards-space-rename"
      aria-label={`Rename workspace ${name}`}
      defaultValue={name}
      // The row is a drag handle and the list is a cursor; neither may read a
      // press or a keystroke aimed at the field.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          cancelled.current = true;
          onCommit(draft());
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancelled.current = true;
          onCancel();
          return;
        }
        // Arrows and characters belong to the field while it is open.
        e.stopPropagation();
      }}
      onBlur={() => {
        if (cancelled.current) return;
        cancelled.current = true;
        onCommit(draft());
      }}
    />
  );
}

/** A WORKSPACE header — the outermost row ([P09], Spec S04, Spec S05). */
export const SpaceHeaderCell: TugListViewCellRenderer<CardsDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<CardsDataSource>) => {
  const row = dataSource.rowAt(index);
  const ctx = useCellContext();
  // `row?.` rather than an early return: `useSpaceRowMenu` is a hook and may
  // not sit behind one, so the absent row has to be spelled in the two
  // ternaries that feed it. The guard below is what actually draws nothing.
  const spaceId = row?.type === "space-header" ? row.spaceId : "";
  const name = row?.type === "space-header" ? row.name : "";
  const menu = useSpaceRowMenu({
    spaceId,
    name,
    spaceCount: ctx.spaceCount,
  });
  if (row === undefined || row.type !== "space-header") return null;
  const renaming = ctx.renamingSpaceId === row.spaceId;
  return (
    <TugListRow
      className="cards-space-header"
      data-cards-space-id={row.spaceId}
      data-cards-space-active={row.active ? "true" : "false"}
      data-cards-space-run={row.spaceId}
      data-testid="cards-space-header"
      // The header is the workspace run's drag handle — the header and every
      // row under it carry `data-cards-space-run`, so the whole workspace
      // travels as one block ([P10]).
      onPointerDown={
        renaming ? undefined : (e) => ctx.onSpacePointerDown(row.spaceId, e)
      }
      onContextMenu={(e) => {
        if (menu.menu === null) return;
        e.preventDefault();
        e.stopPropagation();
        menu.openMenuAt(e.clientX, e.clientY);
      }}
      trailing={
        <>
          {/* What the workspace HOLDS, at the trailing edge, pipe-delimited —
              the tool-call block header's trailing run, on a list row ([P09]).

              It used to read as part of the name (`Main: 3 cards · 2 live`),
              which made the tally something you had to read PAST to get to
              the thing you were looking for. A workspace's name is what you
              scan a column of these rows for; how much is in it is what you
              check once you have found it. Two different readings want two
              different columns, and the middle dot could not give them one
              because it belonged to the name's own run of text.

              So each tally is its own section with its own LEFT rule and
              never a right one, which is the block header's composition rule
              exactly: any subset of the sections composes with a single line
              and equal air on both sides of it, and there are no adjacency
              cases to write. `live` drops out at zero and the run closes up
              behind it. */}
          <span
            className="cards-space-tally"
            data-slot="cards-space-tally"
            data-testid="cards-space-count"
          >
            <TugBadge emphasis="ghost" role="inherit" size="sm">
              {row.summary}
            </TugBadge>
          </span>
          {row.sessionsLive > 0 ? (
            <span
              className="cards-space-tally"
              data-slot="cards-space-tally"
              data-testid="cards-space-live"
            >
              <TugBadge emphasis="ghost" role="inherit" size="sm">
                {`${row.sessionsLive} live`}
              </TugBadge>
            </span>
          ) : null}
          {/* The controls are the run's last section and take a rule of their
              own, for the block header's reason: the jump from what the
              workspace HOLDS to what you can DO to it is a bigger one than the
              jump between two tallies, and without the rule it was the only
              boundary in the row with less air than the boundaries either side
              of it. */}
          <span className="cards-space-tally cards-space-tally-controls">
          {/* The visible door to the same three verbs the right-click opens
              ([B01]). It opens the menu at its own rect rather than at a
              pointer position, which is what makes it a button rather than a
              second right-click. It sits AHEAD of the fold cue so the cue
              stays at the row's edge, where it is on every other header. */}
          <TugIconButton
            className="cards-header-verbs"
            icon={<MoreHorizontal />}
            aria-label={`Actions for workspace ${row.name}`}
            // The row is the workspace's own door — a press arms its carry and
            // a click goes there — so the trigger has to keep both events to
            // itself. Otherwise opening the menu would also travel to the
            // workspace, which is the opposite of what a person reaching for
            // "Delete" meant.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e?.stopPropagation();
              const el = e?.currentTarget;
              if (el === undefined) return;
              const rect = el.getBoundingClientRect();
              menu.openMenuAt(rect.left, rect.bottom);
            }}
            data-testid="cards-space-verbs-button"
            size="2xs"
          />
          {/* Always drawn, so every header ends at the same edge, and never
              disabled: every workspace folds, the active one included, which
              is what makes the cue mean something to a person with one
              workspace ([B02]). */}
          <BlockFoldCue
            className="cards-header-fold"
            collapsed={!row.expanded}
            onToggle={() => ctx.onToggleSpace(row.spaceId)}
            collapsedLabel="Expand"
            expandedLabel="Collapse"
            ariaLabelExpand={`Expand ${row.name}`}
            ariaLabelCollapse={`Collapse ${row.name}`}
            size="2xs"
            subtype="icon"
            data-slot="cards-space-fold"
          />
          </span>
          {menu.menu}
        </>
      }
    >
      <span className="cards-header-line">
        {/* The mark: which workspace is on screen. An OPEN EYE on the one you
            are looking at, a CLOSED one on every workspace whose cards the
            deck is not drawing — the fact this column reports is visibility,
            and an eye says it in the glyph itself rather than by convention.
            A dot is the house's activity mark — it carries a phase and it
            pulses — and being the workspace you are in is not a phase. The
            column holds its width so the names do not shift when the mark
            moves, and the active name carries the accent so the row still
            reads at a glance without looking at this column at all. */}
        <span className="cards-header-glyph" aria-hidden="true">
          {row.active ? <Eye /> : <EyeClosed />}
        </span>
        {renaming ? (
          <SpaceRenameField
            key={row.spaceId}
            name={row.name}
            focusGroup={ctx.focusGroup}
            takeKeyboard={ctx.focusRenameField}
            onCommit={(next) => ctx.onCommitRename(row.spaceId, next)}
            onCancel={ctx.onCancelRename}
          />
        ) : (
          <TugLabel className="tug-list-row-title" size="sm" maxLines={1}>
            <span data-testid="cards-space-name">{row.name}</span>
          </TugLabel>
        )}
      </span>
    </TugListRow>
  );
};
