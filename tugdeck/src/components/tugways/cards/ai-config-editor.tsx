/**
 * ai-config-editor.tsx — the surface that sets how the AI runs. Declared once,
 * worn by both places that set it.
 *
 * Model, reasoning effort, and permission mode are one thought — "how should
 * Claude run?" — and this is that thought's editor, whole: a **readout** of the
 * current triple in the largest type present, a **scope line** saying whose
 * settings these are, and one **channel** per parameter under them.
 *
 * Its two hosts are the session card's mixer sheet
 * ({@link module:components/tugways/cards/ai-config-sheet}), which frames it in
 * a transaction with an OK, and the Settings card's AI Model box, which frames
 * it in a panel and writes each move straight through. **Only the frame and the
 * scope line differ** — everything inside is this one component, so the two
 * cannot drift into looking like two different features, and neither host is
 * given a knob to make them.
 *
 * The three channels, each with the control its parameter's shape deserves, its
 * own caption, and its own description line under it:
 *
 *  - **Model** — a `TugListView` option list, because a model is the decision
 *    people actually deliberate: every option carries its own name AND
 *    description, at a size worth reading. Superseded versions of a family
 *    ({@link foldOlderModels}) fold behind a "Show older models" toggle under
 *    the list, so the front rank is the handful of choices people make.
 *  - **Effort** — a `TugSlider` **stepped track** (`showTicks` + `tickLabel`),
 *    because effort is ordinal. The track spans exactly the levels the current
 *    model offers, so an unreachable level is absent rather than greyed.
 *  - **Mode** — a compact `TugChoiceGroup`, the right control for a small flat
 *    set of named alternatives.
 *
 * The editor is **value + onChange**, and it owns no state. The sheet drives it
 * from a pending triple it holds until OK, because a session's model+effort
 * change costs a claude respawn and must be batched; the Settings box drives it
 * from the deck defaults and applies every move at once, because a default
 * costs nothing. Two dispositions of the same editor, one implementation.
 *
 * The model↔effort coupling lives here, once: choosing a model recomputes the
 * effort support and clamps a stranded level DOWN
 * ({@link clampEffortToSupport}), so no caller can produce a triple the commit
 * could not honor.
 *
 * The editor is also its own responder scope: the slider's `setValue` and the
 * choice group's `selectValue` land here and leave as semantic
 * `onChange(next, changed)` calls, so a host wires three parameters without
 * knowing that effort reports a tick index ([L11]).
 *
 * Compositional component — composes `TugLabel`, `TugListView`, `TugListRow`,
 * `TugSlider`, and `TugChoiceGroup`; composed children keep their own tokens
 * [L20]. Layout lives in ai-config-editor.css [L06].
 *
 * @module components/tugways/cards/ai-config-editor
 */

import "./ai-config-editor.css";
import "./sheet-option-list.css";

import React, { useCallback, useId, useMemo, useState } from "react";

import { TugLabel } from "@/components/tugways/tug-label";
import { TugSlider } from "@/components/tugways/tug-slider";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
  type TugListViewDelegate,
} from "@/components/tugways/tug-list-view";
import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import type { TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { useResponder } from "@/components/tugways/use-responder";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import type { CapabilityModel } from "@/lib/session-metadata-store";
import { compressContextPhrase, resolveModelLabel, knownModelRows } from "@/lib/model-label";
import { formatEffortLabel, resolveEffortSupport } from "@/lib/effort";
import { foldOlderModels } from "@/lib/model-picker-data";
import {
  PERMISSION_MODE_MENU,
  formatPermissionMode,
  isPermissionMode,
} from "@/lib/permission-mode";
import {
  AI_CONFIG_UNKNOWN_MODEL,
  clampEffortToSupport,
  type AiConfigBaseline,
  type AiConfigRow,
  type AiConfigSources,
} from "@/lib/ai-config";

/**
 * Brief description per effort level — claude's own `/effort` framing ("how
 * long Claude thinks before answering"). Presentational copy, so it lives with
 * the surface that shows it rather than in the pure `lib/effort.ts`.
 */
const EFFORT_SUBTITLES: Record<string, string> = {
  low: "Quick edits and simple tasks",
  medium: "Balanced thinking",
  high: "Tricky bugs and harder tasks",
  xhigh: "The hardest problems",
  max: "Maximum thinking budget",
};

/**
 * Brief description per permission mode. Wording tracks the Claude Code Agent
 * SDK permission-mode docs (code.claude.com/docs → Configure permissions):
 * `default` prompts; `acceptEdits` auto-approves file edits; `plan` is
 * read-only; `auto` uses a model classifier per call; `bypassPermissions`
 * skips prompts.
 */
const PERMISSION_MODE_SUBTITLES: Record<string, string> = {
  default: "Prompts before edits and commands",
  acceptEdits: "Auto-approves file edits",
  plan: "Read-only; plans without changes",
  auto: "Model approves or denies each call",
  bypassPermissions: "Runs all tools without prompts",
};

/** The description shown when a row's value has no copy of its own. */
const NO_DESCRIPTION = "";

/** Focus orders within the host's focus group, relative to `focusOrderBase`. */
export const AI_CONFIG_ROW_OFFSET: Record<AiConfigRow, number> = {
  model: 0,
  effort: 1,
  mode: 2,
};

/** How many focus orders the editor consumes — the host numbers around it. */
export const AI_CONFIG_ROW_COUNT = 3;

export interface AiConfigEditorProps {
  /** Options + capability lists, from {@link resolveAiConfigSources}. */
  sources: AiConfigSources;
  /**
   * What the channels read — the sheet's pending triple, or the deck defaults
   * as they stand. Same shape as the commit baseline, so a host diffs one
   * against the other with no mapping in between.
   */
  value: AiConfigBaseline;
  /**
   * The next whole triple, plus which channel the reader moved. The triple is
   * already clamped — a model change carries the effort it forced.
   */
  onChange: (next: AiConfigBaseline, changed: AiConfigRow) => void;
  /**
   * One line saying **whose** settings these are, under the readout. The
   * editor is the same in both hosts and only this line tells them apart, so
   * neither leaves the reader guessing whether a move reaches one session or
   * every new one. It is host copy — the one thing a host says for itself.
   */
  scopeNote: string;
  /** The host's focus group; the editor claims three consecutive orders. */
  focusGroup: string;
  /** The first of those orders. Defaults to 0. */
  focusOrderBase?: number;
}

// ---------------------------------------------------------------------------
// The model channel's option list
// ---------------------------------------------------------------------------

/**
 * The current model, published to the cell renderers so the matching row paints
 * selected. Selection changes through the list's delegate, so this only carries
 * the read-only "which row is current" value.
 */
const ModelListContext = React.createContext<string | null>(null);

/**
 * Static, single-section data source over the model options. The set is fixed
 * for as long as the capability list is, so `subscribe` is a no-op and
 * `getVersion` a stable constant.
 */
class ModelListDataSource implements TugListViewDataSource {
  private readonly models: readonly CapabilityModel[];

  constructor(models: readonly CapabilityModel[]) {
    this.models = models;
  }

  numberOfItems(): number {
    return this.models.length;
  }

  idForIndex(index: number): string {
    return this.models[index].value;
  }

  kindForIndex(): string {
    return "model";
  }

  /** Cell-renderer accessor — the model at `index`. */
  modelAt(index: number): CapabilityModel {
    return this.models[index];
  }

  subscribe(): () => void {
    return () => {};
  }

  getVersion(): unknown {
    return 0;
  }
}

/**
 * One model row: the display name over its description, with a leading check on
 * the current one. `selectedGlyph="check"` reserves the check column on every
 * row so the names align whether or not a row carries the mark. The verbose
 * context phrase is compressed to the ` · 1M` idiom and may wrap to a second
 * line rather than truncate — the description is the reason this channel is a
 * list instead of a row of chips.
 */
const ModelListCell: TugListViewCellRenderer<ModelListDataSource> =
  function ModelListCell({
    index,
    dataSource,
  }: TugListViewCellProps<ModelListDataSource>): React.ReactElement {
    const current = React.useContext(ModelListContext);
    const model = dataSource.modelAt(index);
    return (
      <TugListRow
        title={model.displayName}
        subtitle={
          model.description !== undefined
            ? compressContextPhrase(model.description)
            : undefined
        }
        subtitleMaxLines={2}
        selected={model.value === current}
        selectedGlyph="check"
        data-model={model.value}
      />
    );
  };

const MODEL_CELL_RENDERERS: Record<
  string,
  TugListViewCellRenderer<ModelListDataSource>
> = {
  model: ModelListCell,
};

// ---------------------------------------------------------------------------
// AiConfigEditor
// ---------------------------------------------------------------------------

export function AiConfigEditor({
  sources,
  value,
  onChange,
  scopeNote,
  focusGroup,
  focusOrderBase = 0,
}: AiConfigEditorProps): React.ReactElement {
  const { options, models, catalog } = sources;

  // Effort support follows the CURRENT model, so choosing a narrower model
  // narrows the track the instant it is chosen.
  const support = resolveEffortSupport(models, value.modelSelector, catalog);
  const levels = support.levels;

  // The label rows behind `resolveModelLabel` — a model named in copy here
  // comes through the same single helper the chip uses, so the two agree.
  const rows = knownModelRows(models, catalog);

  const selectModel = useCallback(
    (selector: string) => {
      // The new model may not offer the current level; clamp DOWN rather than
      // strand a selection the commit could not honor.
      const nextLevels = resolveEffortSupport(models, selector, catalog).levels;
      onChange(
        {
          modelSelector: selector,
          effortLevel: clampEffortToSupport(value.effortLevel, nextLevels),
          mode: value.mode,
        },
        "model",
      );
    },
    [models, catalog, onChange, value.effortLevel, value.mode],
  );

  // Stable senders per channel, so the scope's handlers tell them apart. The
  // model channel has none: a `TugListView` reports through its delegate.
  const effortSenderId = useId();
  const modeSenderId = useId();

  const { ResponderScope, responderRef } = useResponder({
    id: "ai-config-editor",
    actions: {
      [TUG_ACTIONS.SELECT_VALUE]: (event: ActionEvent) => {
        const next = event.value;
        if (typeof next !== "string") return;
        if (event.sender !== modeSenderId || !isPermissionMode(next)) return;
        onChange({ ...value, mode: next }, "mode");
      },
      // The effort track is a `TugSlider`, so it reports a NUMBER — the index
      // of a notch on the current model's own level list — through `setValue`
      // rather than `selectValue`. Every phase is applied, including the drag's
      // `cancel` (which carries the pre-drag value, i.e. the restore).
      [TUG_ACTIONS.SET_VALUE]: (event: ActionEvent) => {
        if (event.sender !== effortSenderId) return;
        const index = event.value;
        if (typeof index !== "number") return;
        const level = levels[index];
        if (level === undefined) return;
        onChange({ ...value, effortLevel: level }, "effort");
      },
    },
  });

  // ---- The model channel's list ----

  // Older versions fold away until asked for. The current pick is never
  // folded out of sight: collapsed, it keeps its catalog slot among the
  // front rank, so the checkmark is always on a visible row.
  const fold = useMemo(() => foldOlderModels(options), [options]);
  const [showOlder, setShowOlder] = useState(false);
  const shown = useMemo(
    () =>
      showOlder
        ? options
        : options.filter(
            (option) =>
              !fold.older.includes(option) ||
              option.value === value.modelSelector,
          ),
    [options, fold, showOlder, value.modelSelector],
  );

  const dataSource = useMemo(() => new ModelListDataSource(shown), [shown]);
  const delegate = useMemo<TugListViewDelegate>(
    () => ({ onSelect: (index) => selectModel(shown[index].value) }),
    [shown, selectModel],
  );
  const currentModelIndex = shown.findIndex(
    (option) => option.value === value.modelSelector,
  );

  // ---- The effort channel's track ----
  //
  // The track is indexed over the CURRENT model's own supported levels, not
  // over the canonical five. That is what makes an unreachable level
  // unreachable: there is no notch to land on, so no clamping is needed at the
  // control layer and a non-contiguous support set (a model offering low and
  // high but not medium) still cannot produce an invalid pick.
  const effortIndex = Math.max(
    0,
    levels.findIndex((level) => level === value.effortLevel),
  );
  const effortDescription =
    levels.length === 0
      ? `${resolveModelLabel(value.modelSelector, rows) ?? "This model"} does not offer reasoning effort`
      : value.effortLevel === null
        ? NO_DESCRIPTION
        : (EFFORT_SUBTITLES[value.effortLevel] ?? NO_DESCRIPTION);

  // ---- The mode channel's segments ----

  const modeItems: TugChoiceItem[] = PERMISSION_MODE_MENU.map((mode) => ({
    value: mode,
    label: formatPermissionMode(mode),
  }));

  return (
    <ResponderScope>
      <div
        className="ai-config-editor"
        data-slot="ai-config-editor"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        {/* The readout: the triple as it stands, in the largest type on the
            surface. The model carries the most weight because it is the
            decision the other two qualify. In the sheet this is the pending
            state — what OK will commit; in the Settings box it is what the
            deck defaults already are. */}
        <div className="ai-config-readout" data-slot="ai-config-summary">
          <span className="ai-config-readout-model">
            {resolveModelLabel(value.modelSelector, rows) ?? AI_CONFIG_UNKNOWN_MODEL}
          </span>
          <span className="ai-config-readout-rest">
            {/* The spaces live in the text, not in a margin, so the readout
                reads correctly when it is taken as a string. */}
            {value.effortLevel !== null && (
              <>
                <span className="ai-config-readout-sep"> · </span>
                {formatEffortLabel(value.effortLevel)}
              </>
            )}
            <span className="ai-config-readout-sep"> · </span>
            {formatPermissionMode(value.mode)}
          </span>
        </div>

        {/* Directly under the readout, because it qualifies it: the readout
            says what is set, this says where it lands. */}
        <div className="ai-config-scope" data-slot="ai-config-scope">
          {scopeNote}
        </div>

        <div className="ai-config-channels">
          <div className="ai-config-channel ai-config-channel-model">
            <TugLabel size="md" emphasis="proposal" className="ai-config-caption">
              Model
            </TugLabel>
            {/* The test hook rides the wrapper, not the list: `TugListView`
                does not forward unknown props to its root. */}
            <div
              className="ai-config-model-list sheet-option-list"
              data-testid="ai-config-model"
            >
              <ModelListContext.Provider value={value.modelSelector}>
                <TugListView<ModelListDataSource>
                  dataSource={dataSource}
                  delegate={delegate}
                  cellRenderers={MODEL_CELL_RENDERERS}
                  rowLayout="flush"
                  inline
                  focusGroup={focusGroup}
                  focusOrder={focusOrderBase + AI_CONFIG_ROW_OFFSET.model}
                  singleSelect
                  initialSelectedIndex={currentModelIndex}
                />
              </ModelListContext.Provider>
            </div>
            {fold.older.length > 0 && (
              // Deliberately outside the focus group, like the sheet's footer
              // links: a push button holding the key view wears the default
              // treatment, and a list's disclosure must never read as the
              // sheet's Return action.
              <div className="ai-config-older-models">
                <TugPushButton
                  size="sm"
                  emphasis="ghost"
                  role="action"
                  data-slot="ai-config-older-models"
                  aria-expanded={showOlder}
                  onClick={() => setShowOlder((open) => !open)}
                >
                  {showOlder ? "Hide older models" : "Show older models"}
                </TugPushButton>
              </div>
            )}
          </div>

          <div className="ai-config-channel">
            <TugLabel size="md" emphasis="proposal" className="ai-config-caption">
              Effort
            </TugLabel>
            {/* The stepped track spans exactly the current model's levels, so
                a model that offers none renders a disabled single-notch track
                and says so in its description rather than presenting five
                greyed chips to decode. */}
            <div className="ai-config-track">
              <TugSlider
                value={effortIndex}
                senderId={effortSenderId}
                min={0}
                max={Math.max(0, levels.length - 1)}
                step={1}
                size="sm"
                showTicks
                showValue={false}
                tickLabel={(_value, index) => formatEffortLabel(levels[index])}
                disabled={levels.length === 0}
                focusGroup={focusGroup}
                focusOrder={focusOrderBase + AI_CONFIG_ROW_OFFSET.effort}
                aria-label="Reasoning effort"
                data-testid="ai-config-effort"
              />
            </div>
            <div className="ai-config-note">{effortDescription}</div>
          </div>

          <div className="ai-config-channel">
            <TugLabel size="md" emphasis="proposal" className="ai-config-caption">
              Mode
            </TugLabel>
            <TugChoiceGroup
              items={modeItems}
              value={value.mode}
              senderId={modeSenderId}
              size="sm"
              sidePadding="xs"
              columns="proportional"
              commit="live"
              focusGroup={focusGroup}
              focusOrder={focusOrderBase + AI_CONFIG_ROW_OFFSET.mode}
              aria-label="Permission mode"
              data-testid="ai-config-mode"
            />
            <div className="ai-config-note">
              {PERMISSION_MODE_SUBTITLES[value.mode] ?? NO_DESCRIPTION}
            </div>
          </div>
        </div>
      </div>
    </ResponderScope>
  );
}
