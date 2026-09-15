/**
 * cards-space-header.tsx — the WORKSPACE header row and the verbs it carries
 * ([P09], [P11], Spec S05).
 *
 * The outermost row of the Workspaces card. What it draws is the reading: the
 * workspace's name, what it holds while collapsed, how many of its sessions
 * are live, and the mark that says which one is on screen. Click or Enter is
 * the delegate's and on this row means "go there" — `activate-space`, a no-op
 * on the workspace already showing.
 *
 * **The four verbs are context-menu verbs, not buttons on the row.** A person
 * makes a workspace once and deletes one almost never, and the row's whole job
 * in between is to be read and travelled through. So New / Rename / Duplicate
 * / Delete ride a right-click menu, the same grammar the Arcs card's rows take
 * ([L30] — a verb over the thing the right-click landed on is a declared
 * escape from the command table, which is why all four are in
 * `ACTIONS_OUTSIDE_THE_TABLE`).
 *
 * **The menu carries no responder of its own.** `TugEditorContextMenu`
 * dispatches each item to the responder that encloses it in the React tree,
 * and a cell renders inside the card's own `ResponderScope` — so the four
 * actions land on the card body, which is where the deck-store calls, the
 * rename in flight and the delete confirm all live. A cell is recycled as the
 * list changes; none of that could be held here.
 *
 * Laws: [L02] every fact on the row comes from the data source's projection;
 * [L06] the active mark and the drop-target highlight are CSS on `data-*`;
 * [L19] the row composes `TugListRow` and the cue is a real `BlockFoldCue`;
 * [L24] the rename draft is the field's own while it is open.
 *
 * @module components/cards/cards-space-header
 */

import React from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import {
  TugEditorContextMenu,
  type TugEditorContextMenuEntry,
} from "@/components/tugways/tug-editor-context-menu";
import { TugInput } from "@/components/tugways/tug-input";
import { TugLabel } from "@/components/tugways/tug-label";
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
 * cursor happens to be sitting on. New Workspace carries one too — harmless,
 * and it keeps every item's payload one shape.
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
      { action: TUG_ACTIONS.NEW_SPACE, label: "New Workspace", value: {} },
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
  const spaceId = row.type === "space-header" ? row.spaceId : "";
  const name = row.type === "space-header" ? row.name : "";
  const menu = useSpaceRowMenu({
    spaceId,
    name,
    spaceCount: ctx.spaceCount,
  });
  if (row.type !== "space-header") return null;
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
          {/* Always drawn, so every header ends at the same edge, and disabled
              on the active workspace — that one is expanded by the data
              source's own rule and has no other state to offer ([P09]). */}
          <BlockFoldCue
            className="cards-header-fold"
            collapsed={!row.expanded}
            disabled={row.active}
            onToggle={() => ctx.onToggleSpace(row.spaceId)}
            collapsedLabel="Expand"
            expandedLabel="Collapse"
            ariaLabelExpand={`Expand ${row.name}`}
            ariaLabelCollapse={`Collapse ${row.name}`}
            size="2xs"
            subtype="icon"
            data-slot="cards-space-fold"
          />
          {menu.menu}
        </>
      }
    >
      <span className="cards-header-line">
        {/* The mark: which workspace is on screen. A glyph rather than a tone,
            because the row is already quiet and one filled dot reads at a
            glance where a wash does not. */}
        <span className="cards-header-glyph" aria-hidden="true">
          {row.active ? "●" : "○"}
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
            <span className="cards-header-count" data-testid="cards-space-count">
              {`: ${row.summary}`}
            </span>
            {row.sessionsLive > 0 ? (
              <span className="cards-header-count" data-testid="cards-space-live">
                {` · ${row.sessionsLive} live`}
              </span>
            ) : null}
          </TugLabel>
        )}
      </span>
    </TugListRow>
  );
};
