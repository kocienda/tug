/**
 * data-visualization-sheet.tsx — the Data Visualization sheet: every chart
 * recipe with a figure of what it produces and a line on what its data tells.
 *
 * Everything shown comes from the recipe catalog through `chart-recipes-store`,
 * so this file names no recipe and a new one needs no change here. A recipe with
 * data over the card's project draws live; one with none, or whose read failed,
 * draws its sample, marked as one so it is not read as the project's numbers.
 * A row is its title over its description and a thumbnail, which never animates.
 * Draw hands the recipe's name to the card, which places the command in the
 * composer and leaves the send to the user.
 *
 * Compositional — composes `TugSheet` (via the card's shared `showSheet`),
 * `TugSheetScaffold`, `ChartBlock` and `TugPushButton`; composed children keep
 * their own tokens ([L20]).
 *
 * Laws: [L02] store reads via `useSyncExternalStore`, [L06] appearance stays in
 *       CSS and a row's state is an attribute, [L20] composed children keep
 *       tokens, [L33] a read that fails says so in its row.
 * Decisions: [D15] pane sheets are overlays.
 *
 * @module components/tugways/cards/data-visualization-sheet
 */

import "./data-visualization-sheet.css";

import {
  ChartArea,
  ChartBar,
  ChartBarBig,
  ChartColumn,
  ChartColumnBig,
  ChartGantt,
  ChartLine,
  ChartScatter,
  Grid3x3,
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
import {
  recipeFace,
  recipeSections,
  useChartRecipes,
  type RecipeRow,
} from "@/lib/chart-recipes-store";
import { MODAL_REST_LINE } from "./modal-rest-line";

/** The card command behind the menu row and the chord. `/viz` stays the skill's. */
export const DATA_VISUALIZATION_COMMAND = "data-visualization";

/** The command Draw places: the name the popup composes for the `/viz` skill. */
export const VIZ_SKILL_COMMAND = "tugplug:viz";

export interface UseDataVisualizationSheetArgs {
  /** The card's own project, read when the sheet opens; `null` when it has none. */
  projectDir: () => string | null;
  /** Place the recipe's command in the composer, unsent. */
  placeRecipe: (name: string) => void;
  /** The card's shared sheet host (`useTugSheet().showSheet`). */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
}

export interface DataVisualizationSheetController {
  /** Present the sheet or, when it is the one showing, dismiss it. */
  openDataVisualizationSheet: () => void;
}

export function useDataVisualizationSheet({
  projectDir,
  placeRecipe,
  showSheet,
}: UseDataVisualizationSheetArgs): DataVisualizationSheetController {
  // The sheet host is single-slot, so its promise resolving is the authoritative
  // "no longer showing" signal, and what it resolves with is the recipe Draw chose.
  const shownRef = useRef(false);
  const closeRef = useRef<(() => void) | null>(null);

  const openDataVisualizationSheet = useCallback(() => {
    if (shownRef.current) {
      closeRef.current?.();
      return;
    }
    shownRef.current = true;
    const dir = projectDir();
    void showSheet({
      title: "Data Visualization",
      icon: "ChartColumn",
      displayWidth: "xl",
      presentation: "rise",
      bottomAnchorSelector: MODAL_REST_LINE,
      content: (close) => (
        <DataVisualizationSheetBody projectDir={dir} onClose={close} registerClose={closeRef} />
      ),
    }).then((chosen) => {
      shownRef.current = false;
      closeRef.current = null;
      if (chosen !== undefined) placeRecipe(chosen);
    });
  }, [projectDir, placeRecipe, showSheet]);

  return { openDataVisualizationSheet };
}

interface DataVisualizationSheetBodyProps {
  projectDir: string | null;
  onClose: (value?: string) => void;
  /** Hands this sheet's `close` back to the controller, for the chord's re-press. */
  registerClose: React.MutableRefObject<(() => void) | null>;
}

function DataVisualizationSheetBody({
  projectDir,
  onClose,
  registerClose,
}: DataVisualizationSheetBodyProps): React.ReactElement {
  const { rows, listFailure } = useChartRecipes(projectDir);

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
      if (value?.name === DATA_VISUALIZATION_COMMAND) onClose();
    });
  }, [manager, onClose]);

  const doneFocusGroup = React.useId();
  useSeedKeyView(`${doneFocusGroup}:0`);

  let notice: string | null = null;
  if (projectDir === null) notice = "No project is open.";
  else if (rows === null) notice = listFailure !== null ? `Could not read the recipes: ${listFailure}` : "Reading the recipes…";
  else if (listFailure !== null) notice = `Could not refresh the recipes: ${listFailure}`;

  return (
    <TugSheetScaffold
      className="data-visualization-sheet"
      footer={
        <div className="data-visualization-sheet-footer">
          <TugPushButton
            size="sm"
            emphasis="primary"
            onClick={() => onClose()}
            data-testid="data-visualization-done"
            focusGroup={doneFocusGroup}
            focusOrder={0}
          >
            Done
          </TugPushButton>
        </div>
      }
    >
      <div className="data-visualization-sheet-body" data-testid="data-visualization-sheet">
        {notice !== null ? (
          <p className="data-visualization-sheet-notice" role="status">
            {notice}
          </p>
        ) : null}
        {projectDir !== null && rows !== null
          ? recipeSections(rows).map((section) => (
              <section className="data-visualization-sheet-section" aria-label={section.group} key={section.group}>
                <div className="data-visualization-sheet-section-title">{section.group}</div>
                {section.rows.map((row) => (
                  <RecipeRowView key={row.name} row={row} onDraw={onClose} />
                ))}
              </section>
            ))
          : null}
      </div>
    </TugSheetScaffold>
  );
}

/** The icon for a catalog `form`. A form this does not know wears the plain chart. */
function formIcon(form: string): LucideIcon {
  if (form.includes("area")) return ChartArea;
  if (form.includes("line")) return ChartLine;
  if (form.includes("spans")) return ChartGantt;
  if (form.includes("histogram")) return ChartColumnBig;
  if (form.includes("heat")) return Grid3x3;
  if (form.includes("bullet")) return ChartBarBig;
  if (form.includes("dots") || form.includes("scatter")) return ChartScatter;
  if (form.includes("horizontal")) return ChartBar;
  return ChartColumn;
}

function RecipeRowView({
  row,
  onDraw,
}: {
  row: RecipeRow;
  onDraw: (name: string) => void;
}): React.ReactElement {
  const face = recipeFace(row);
  const Icon = formIcon(row.form);
  return (
    <div className="data-visualization-sheet-row" data-tugx-recipe={row.name} data-tugx-recipe-state={face.state}>
      <div className="data-visualization-sheet-title">
        <div className="data-visualization-sheet-heading">
          <Icon className="data-visualization-sheet-icon" size={16} aria-hidden />
          <div className="data-visualization-sheet-name">{row.name}</div>
        </div>
        {face.sampled ? <div className="data-visualization-sheet-sample-mark">Sample</div> : null}
      </div>
      <div className="data-visualization-sheet-text">
        <div className="data-visualization-sheet-tells">{row.tells}</div>
        {face.line !== null ? <div className="data-visualization-sheet-line">{face.line}</div> : null}
        <div className="data-visualization-sheet-actions">
          <TugPushButton size="sm" emphasis="outlined" onClick={() => onDraw(row.name)} data-testid={`data-visualization-draw-${row.name}`}>
            Draw
          </TugPushButton>
        </div>
      </div>
      <div className="data-visualization-sheet-figure">
        {face.spec === null ? (
          <div className="data-visualization-sheet-running">Running…</div>
        ) : (
          <ChartBlock source={JSON.stringify(face.spec)} thumbnail />
        )}
      </div>
    </div>
  );
}
