/**
 * skills-sheet.tsx — the `/skills` read-only listing sheet ([#step-12d]).
 *
 * `/skills` lists the project's **plugin + user** skills — the on-disk,
 * user-manageable set, matching Claude Code's own `/skills` (built-in skills
 * live inside the claude package and surface in `/context`, not here). Each
 * row shows the skill's name, a lock glyph for plugin-managed skills, the
 * one-line description, and a trailing `<source> · ~N tok` — the columns
 * Claude Code's terminal `/skills` shows, every one sourced by tugcode from
 * the skill's `SKILL.md`.
 *
 * Sourcing is single-shot, not a feed ([D21]-style): {@link useSkillsSheet}
 * fires a `skills_inventory_query` on open (and on the in-sheet refresh) via
 * {@link SkillsInventoryStore}, and the body renders the matching response
 * read through `useSyncExternalStore` ([L02]). Read-only — built-in skills
 * have no editable backing file and plugin skills are author-locked, so there
 * is no row activation.
 *
 * Compositional — composes `TugSheet` (via the card's shared `showSheet`),
 * `TugSheetScaffold`, `TugListView`, `TugListRow`, `TugPushButton`,
 * `TugLabel`; composed children keep their own tokens ([L20]).
 *
 * Laws: [L02] store reads via `useSyncExternalStore`, [L06] appearance via
 *       CSS, [L20] composed children keep tokens.
 * Decisions: [D15] pane sheets are overlays.
 *
 * @module components/tugways/cards/skills-sheet
 */

import "./skills-sheet.css";

import React, { useCallback, useMemo, useSyncExternalStore } from "react";
import { Lock } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
} from "@/components/tugways/tug-list-view";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import { TugSheetScaffold } from "@/components/tugways/tug-sheet-scaffold";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import {
  type SkillInventoryEntry,
  type SkillsInventoryStore,
  formatSkillTokens,
  skillLockLabel,
  skillSourceLabel,
  skillsSummaryLine,
} from "@/lib/skills-inventory-store";
import { MODAL_REST_LINE } from "./modal-rest-line";

// ---------------------------------------------------------------------------
// useSkillsSheet — the card-hosted /skills sheet
// ---------------------------------------------------------------------------

export interface UseSkillsSheetArgs {
  /** Store that fires `skills_inventory_query` and resolves the reply. */
  skillsInventoryStore: SkillsInventoryStore;
  /** The card's shared sheet host (`useTugSheet().showSheet`). */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
}

export interface SkillsSheetController {
  /** Present the `/skills` sheet, firing a fresh request for this session. */
  openSkillsSheet: () => void;
}

export function useSkillsSheet({
  skillsInventoryStore,
  showSheet,
}: UseSkillsSheetArgs): SkillsSheetController {
  const openSkillsSheet = useCallback(() => {
    // Always open the sheet — unlike `/diff`, there is no "nothing to show"
    // alert path: a project with no plugin/user skills is a legitimate (and
    // informative) empty list. The body renders loading → list.
    skillsInventoryStore.requestInventory();
    void showSheet({
      title: "Skills",
      icon: "Wrench",
      displayWidth: "lg",
      presentation: "rise",
      bottomAnchorSelector: MODAL_REST_LINE,
      content: (close) => (
        <SkillsSheetBody
          skillsInventoryStore={skillsInventoryStore}
          onClose={close}
        />
      ),
    });
  }, [skillsInventoryStore, showSheet]);

  return { openSkillsSheet };
}

// ---------------------------------------------------------------------------
// List data source + cell — one row per skill
// ---------------------------------------------------------------------------

/**
 * Static, single-section data source over the resolved skill list. A refresh
 * produces a fresh payload → a fresh array → (via the body's `useMemo`) a
 * fresh data source, so `subscribe` is a no-op and `getVersion` is stable.
 */
class SkillsDataSource implements TugListViewDataSource {
  private readonly skills: readonly SkillInventoryEntry[];

  constructor(skills: readonly SkillInventoryEntry[]) {
    this.skills = skills;
  }

  numberOfItems(): number {
    return this.skills.length;
  }

  idForIndex(index: number): string {
    return this.skills[index].name;
  }

  kindForIndex(): string {
    return "skill";
  }

  /** Cell-renderer accessor — the skill at `index`. */
  skillAt(index: number): SkillInventoryEntry {
    return this.skills[index];
  }

  subscribe(): () => void {
    return () => {};
  }

  getVersion(): unknown {
    return this.skills;
  }
}

/**
 * One skill row — a flush `TugListRow`: a leading lock glyph for plugin-managed
 * skills, the name over its description, and a trailing `<source> · ~N tok`.
 * Presentational and non-interactive (read-only listing).
 */
const SkillsCell: TugListViewCellRenderer<SkillsDataSource> = function SkillsCell({
  index,
  dataSource,
}: TugListViewCellProps<SkillsDataSource>): React.ReactElement {
  const skill = dataSource.skillAt(index);
  const lockLabel = skillLockLabel(skill);
  return (
    <TugListRow
      variant="flush"
      title={skill.name}
      subtitle={skill.description.length > 0 ? skill.description : undefined}
      // The description is the full SKILL.md summary — let it wrap to as
      // many lines as it needs instead of ellipsizing at one.
      subtitleMaxLines={0}
      leading={
        <span className="skills-sheet-lock" aria-label={lockLabel ?? undefined}>
          {lockLabel !== null ? <Lock size={13} aria-hidden /> : null}
        </span>
      }
      trailing={
        <span className="skills-sheet-meta">
          <span className="skills-sheet-source">{skillSourceLabel(skill)}</span>
          <span className="skills-sheet-sep" aria-hidden>
            ·
          </span>
          <span className="skills-sheet-tokens">
            {formatSkillTokens(skill.tokens)}
          </span>
        </span>
      }
      data-testid="skill-row"
      data-skill={skill.name}
    />
  );
};

const SKILLS_CELL_RENDERERS: Record<
  string,
  TugListViewCellRenderer<SkillsDataSource>
> = {
  skill: SkillsCell,
};

// ---------------------------------------------------------------------------
// Sheet body — header summary + refresh + the skill list
// ---------------------------------------------------------------------------

interface SkillsSheetBodyProps {
  skillsInventoryStore: SkillsInventoryStore;
  onClose: (value?: string) => void;
}

function SkillsSheetBody({
  skillsInventoryStore,
  onClose,
}: SkillsSheetBodyProps): React.ReactElement {
  const snapshot = useSyncExternalStore(
    skillsInventoryStore.subscribe,
    skillsInventoryStore.getSnapshot,
  );
  const refresh = useCallback(
    () => skillsInventoryStore.requestInventory(),
    [skillsInventoryStore],
  );
  // Seed the Done button as the sheet's live default (filled+ring) on open.
  const doneFocusGroup = React.useId();
  useSeedKeyView(`${doneFocusGroup}:0`);

  const skills = snapshot.payload?.skills ?? [];
  const dataSource = useMemo(() => new SkillsDataSource(skills), [skills]);

  let body: React.ReactElement;
  if (snapshot.phase === "error") {
    body = (
      <p className="skills-sheet-notice" role="alert">
        {snapshot.error ?? "Couldn't load skills."}
      </p>
    );
  } else if (snapshot.phase === "loading" || snapshot.payload === null) {
    body = (
      <p className="skills-sheet-notice" role="status">
        Loading skills…
      </p>
    );
  } else if (skills.length === 0) {
    body = (
      <div className="skills-sheet-notice" role="status">
        <TugLabel emphasis="proposal" size="lg" align="center">
          No plugin or user skills
        </TugLabel>
      </div>
    );
  } else {
    body = (
      <TugListView<SkillsDataSource>
        dataSource={dataSource}
        cellRenderers={SKILLS_CELL_RENDERERS}
        rowLayout="flush"
        inline
        interactive={false}
        className="skills-sheet-list"
      />
    );
  }

  const ready = snapshot.phase === "ready" && snapshot.payload !== null;
  const header = (
    <div className="skills-sheet-header">
      <div className="skills-sheet-header-text">
        {ready ? (
          <span className="skills-sheet-summary">
            {skillsSummaryLine(skills.length)}
            <span className="skills-sheet-managed"> · plugin skills are managed via /plugin</span>
          </span>
        ) : null}
      </div>
      <div className="skills-sheet-header-actions">
        <TugPushButton
          size="sm"
          emphasis="ghost"
          onClick={refresh}
          disabled={snapshot.phase === "loading"}
          data-testid="skills-refresh"
        >
          Refresh
        </TugPushButton>
      </div>
    </div>
  );

  return (
    <TugSheetScaffold
      className="skills-sheet"
      header={header}
      footer={
        <div className="tug-sheet-actions">
          <TugPushButton
            size="sm"
            emphasis="primary"
            onClick={() => onClose()}
            data-testid="skills-done"
            focusGroup={doneFocusGroup}
            focusOrder={0}
          >
            Done
          </TugPushButton>
        </div>
      }
    >
      {body}
    </TugSheetScaffold>
  );
}
