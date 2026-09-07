/**
 * settings-session-card-body.tsx — the Session Card settings panel.
 *
 * The editor/response preferences that previously lived behind the Dev
 * card's title-bar `…` sheet, now hosted by the Settings card's
 * "Sessions" tab. Three stacked sections:
 *
 *   1. **Transcript** — Magnification (CSS `zoom` on the transcript
 *      root, per card). The macOS app's View menu (`WKWebView.pageZoom`)
 *      scales the whole window and composes with the per-card
 *      magnification.
 *   2. **Prompt Editor** — typography, view toggles, tab policy, and
 *      submit-key policy for the prompt editor.
 *   3. **AI Model** — the deck-wide default model / reasoning effort /
 *      permission mode new cards adopt on first open. The control is
 *      {@link AiConfigEditor} — the very component the Session card's mixer
 *      sheet shows, not a copy of it — bound to the deck defaults via
 *      `DefaultsMetadataAdapter` and rendered on the page rather than behind a
 *      button, because a settings panel shows its settings. Only the scope
 *      line differs. There is no OK because there is nothing to batch: a deck
 *      default respawns nothing, so each move writes at once, like every other
 *      control on this panel.
 *
 * Self-contained: the panel constructs its own `EditorSettingsStore` /
 * `TranscriptSettingsStore` instances at mount and disposes them on
 * unmount. Both stores read/write **global** tugbank domains and
 * observe `onDomainChanged`, so edits made here propagate live to
 * every open Session card (whose own instances watch the same domains) —
 * no shared store instance is required. Neither instance is ever
 * `bind()`-ed to a DOM element, so this panel never writes editor CSS
 * variables itself; it only persists.
 *
 * Laws: store snapshots enter via `useSyncExternalStore` [L02]; the
 * controls dispatch through the chain to this panel's
 * `useResponderForm` responder ([L11]); layout lives in
 * settings-session-card-body.css [L06].
 *
 * @module components/tugways/cards/settings-session-card-body
 */

import React, { useEffect, useId, useState, useSyncExternalStore } from "react";
import { TugBox } from "../tug-box";
import { TugChoiceGroup } from "../tug-choice-group";
import { TugLabel } from "../tug-label";
import { TugPopupButton } from "../tug-popup-button";
import { TugSlider } from "../tug-slider";
import { TugSwitch } from "../tug-switch";
import { TugValueInput } from "../tug-value-input";
import { useResponderForm } from "../use-responder-form";
import { AiConfigEditor } from "./ai-config-editor";
import { EDITOR_FONT_OPTIONS, FONT_SIZE_OPTIONS } from "./editor-font-options";
import { clampEditorTabSize, EditorSettingsStore } from "@/lib/editor-settings-store";
import { TranscriptSettingsStore } from "@/lib/transcript-settings-store";
import { DefaultsMetadataAdapter } from "@/lib/defaults-metadata-adapter";
import {
  computeAiConfigCommit,
  resolveAiConfigSources,
  type AiConfigBaseline,
} from "@/lib/ai-config";
import { createNumberFormatter } from "@/lib/tug-format";
import "./settings-session-card-body.css";

/**
 * Two-decimal formatter for the magnification slider's value input.
 * `0.5` → `"0.50"`, `1` → `"1.00"`, `1.5` → `"1.50"`. Module-scope so
 * the formatter identity stays stable across renders.
 */
const MAGNIFICATION_FORMATTER = createNumberFormatter({ decimals: 2 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Plain-language legend for the submit-key option groups — one line per
 * combination (Return, Shift+Return, Enter, Shift+Enter) describing
 * exactly what it does under the current `returnKeyAction` /
 * `numpadEnterAction`. Shift always inverts the unshifted action, so a
 * single boolean per key drives both of its lines. Recomputed on every
 * render so the legend tracks the choice groups live.
 */
function submitKeyLegend(
  returnKeyAction: "submit" | "newline",
  numpadEnterAction: "submit" | "newline",
): { key: string; effect: string }[] {
  const SUBMIT = "submits";
  const NEWLINE = "inserts a newline";
  const returnSubmits = returnKeyAction === "submit";
  const enterSubmits = numpadEnterAction === "submit";
  return [
    { key: "Return", effect: returnSubmits ? SUBMIT : NEWLINE },
    { key: "Shift+Return", effect: returnSubmits ? NEWLINE : SUBMIT },
    { key: "Enter", effect: enterSubmits ? SUBMIT : NEWLINE },
    { key: "Shift+Enter", effect: enterSubmits ? NEWLINE : SUBMIT },
  ];
}

// ---------------------------------------------------------------------------
// SettingsSessionCardBody
// ---------------------------------------------------------------------------

export function SettingsSessionCardBody() {
  const [editorStore] = useState(() => new EditorSettingsStore());
  const [transcriptStore] = useState(() => new TranscriptSettingsStore());
  // Defaults-shaped metadata store: lets the Z4B chips + picker sheets render
  // the deck defaults unmodified, with rich labels from the persisted catalog.
  // It owns the three deck-default stores the pickers write to.
  const [defaultsAdapter] = useState(() => new DefaultsMetadataAdapter());
  useEffect(
    () => () => {
      editorStore.dispose();
      transcriptStore.dispose();
      defaultsAdapter.dispose();
    },
    [editorStore, transcriptStore, defaultsAdapter],
  );

  const editorSettings = useSyncExternalStore(
    editorStore.subscribe,
    editorStore.getSnapshot,
  );
  const transcriptSettings = useSyncExternalStore(
    transcriptStore.subscribe,
    transcriptStore.getSnapshot,
  );

  // ---- The AI Model channels, bound live to the deck defaults ----
  //
  // The adapter's snapshot is the persisted catalog plus the three default
  // selections, read into channel sources by the same `resolveAiConfigSources`
  // the mixer sheet reads a live session with — one resolution, so "which row
  // is active, which effort is in effect, which mode applies" cannot come to
  // mean two things. The live list and the catalog are the same array here:
  // there is no session behind the defaults to report a narrower one, and no
  // per-card mode to fall back to — this IS the deck-wide value.
  const defaults = useSyncExternalStore(
    defaultsAdapter.subscribe,
    defaultsAdapter.getSnapshot,
  );
  const aiSources = resolveAiConfigSources(defaults, defaults.models, null);

  // No transaction: a deck default costs nothing to change — nothing respawns,
  // no session moves — so each move writes at once, like every other control
  // on this panel. The mixer sheet's OK exists because a *session's*
  // model+effort change costs a respawn; there is none to batch here. It still
  // goes through `computeAiConfigCommit`, so a move carrying two changes (a
  // model that clamps the effort under it) applies exactly the actions, in
  // exactly the order, that OK would.
  const onAiChange = (next: AiConfigBaseline): void => {
    for (const action of computeAiConfigCommit(aiSources.value, next)) {
      switch (action.kind) {
        case "mode":
          defaultsAdapter.permissionModeStore.set(action.value);
          break;
        case "model":
          defaultsAdapter.modelStore.set(action.value);
          break;
        case "effort":
          defaultsAdapter.effortStore.set(action.value);
          break;
      }
    }
  };

  const aiFocusGroup = useId();

  // Stable senders for the controls; the chain dispatches land on the
  // responder scope registered below.
  const fontPopupId = useId();
  const fontSizePopupId = useId();
  const lineWrapId = useId();
  const lineNumbersId = useId();
  const activeLineGutterId = useId();
  const softTabsId = useId();
  const tabSizeId = useId();
  const returnKeyId = useId();
  const enterKeyId = useId();
  const transcriptMagnificationSliderId = useId();

  const { ResponderScope, responderRef } = useResponderForm({
    setValueString: {
      [fontPopupId]: (v: string) => editorStore.set({ fontId: v }),
    },
    setValueNumber: {
      [fontSizePopupId]: (v: number) => editorStore.set({ fontSize: v }),
      [tabSizeId]: (v: number) => editorStore.set({ tabSize: clampEditorTabSize(v) }),
      [transcriptMagnificationSliderId]: (v: number) =>
        transcriptStore.set({ magnification: v }),
    },
    toggle: {
      [lineWrapId]: (v: boolean) => editorStore.set({ lineWrap: v }),
      [lineNumbersId]: (v: boolean) => editorStore.set({ lineNumbers: v }),
      [activeLineGutterId]: (v: boolean) =>
        editorStore.set({ highlightActiveLineGutter: v }),
      [softTabsId]: (v: boolean) => editorStore.set({ softTabs: v }),
    },
    selectValue: {
      [returnKeyId]: (v: string) =>
        editorStore.set({ returnKeyAction: v as "submit" | "newline" }),
      [enterKeyId]: (v: string) =>
        editorStore.set({ numpadEnterAction: v as "submit" | "newline" }),
    },
  });

  return (
    <ResponderScope>
      <div
        className="settings-session-card"
        data-testid="settings-session-card"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <TugBox
          label="Transcript"
          labelPosition="legend"
          variant="bordered"
          className="settings-session-card-group"
        >
          {/* Label + slider on one row, the slider taking the rest of the
              width (see the grid in settings-session-card-body.css).
              Magnification scales the whole transcript subtree (CSS `zoom`
              on `.session-card-transcript`) per card; the macOS app's View
              menu (`WKWebView.pageZoom`) still scales the entire window and
              composes with this. */}
          <div className="settings-session-card-slider-grid">
            <span className="settings-session-card-slider-label">Magnification</span>
            <TugSlider
              className="settings-session-card-slider"
              value={transcriptSettings.magnification}
              min={0.5}
              max={1.5}
              step={0.05}
              senderId={transcriptMagnificationSliderId}
              size="md"
              valueWidth="3.5rem"
              formatter={MAGNIFICATION_FORMATTER}
            />
          </div>
        </TugBox>

        <TugBox
          label="Prompt Editor"
          labelPosition="legend"
          variant="bordered"
          className="settings-session-card-group"
        >
          <div className="settings-session-card-row">
            <TugPopupButton
              className="settings-session-card-popup settings-session-card-popup-font"
              topLabel="Font"
              label={EDITOR_FONT_OPTIONS.find(f => f.value === editorSettings.fontId)?.label ?? "Font"}
              items={EDITOR_FONT_OPTIONS}
              senderId={fontPopupId}
              size="sm"
            />
            <TugPopupButton
              className="settings-session-card-popup settings-session-card-popup-size"
              topLabel="Size"
              label={`${editorSettings.fontSize}px`}
              items={FONT_SIZE_OPTIONS}
              senderId={fontSizePopupId}
              size="sm"
            />
          </div>

          <div className="settings-session-card-switches">
            <TugSwitch
              label="Soft wrap text"
              checked={editorSettings.lineWrap}
              senderId={lineWrapId}
              size="md"
            />
            <TugSwitch
              label="Line numbers"
              checked={editorSettings.lineNumbers}
              senderId={lineNumbersId}
              size="md"
            />
            <TugSwitch
              label="Active line"
              checked={editorSettings.highlightActiveLineGutter}
              senderId={activeLineGutterId}
              size="md"
            />
            <TugSwitch
              label="Auto-expand tabs"
              checked={editorSettings.softTabs}
              senderId={softTabsId}
              size="md"
              data-testid="prompt-editor-option-soft-tabs"
            />
          </div>

          {/* Spaces per tab — the indent unit the Tab key inserts when
              auto-expand is on, and the render width of a literal tab
              either way. Its own row: a number field beside four
              switches reads as a fifth switch otherwise. */}
          <div className="settings-session-card-tabsize">
            <TugLabel size="sm">Spaces per tab</TugLabel>
            <TugValueInput
              value={editorSettings.tabSize}
              senderId={tabSizeId}
              min={1}
              max={16}
              step={1}
              size="sm"
            />
          </div>

          {/* Submit-key policy. One option group per physical key; the
              default (today's behavior) is the first option in each.
              `returnKeyAction` / `numpadEnterAction` are the editor's
              `InputAction`s straight through — shift inverts each. */}
          <div className="settings-session-card-keys">
            {/* Label + choice-group pairs in a 2-column grid. The control
                column is `max-content` (sized to the widest group), and each
                group fills it (`width:auto` + grid stretch) — so both groups
                are equal width and every segment is just as wide as the
                longest of the four choices, never the whole row. */}
            <div className="settings-session-card-key-grid">
              <span className="settings-session-card-key-label">Return key</span>
              <TugChoiceGroup
                className="settings-session-card-key-choice"
                size="sm"
                senderId={returnKeyId}
                value={editorSettings.returnKeyAction}
                aria-label="Return key submit behavior"
                items={[
                  { value: "newline", label: "Shift+Return submits" },
                  { value: "submit", label: "Return submits" },
                ]}
              />
              <span className="settings-session-card-key-label">Enter key</span>
              <TugChoiceGroup
                className="settings-session-card-key-choice"
                size="sm"
                senderId={enterKeyId}
                value={editorSettings.numpadEnterAction}
                aria-label="Enter key submit behavior"
                items={[
                  { value: "submit", label: "Enter submits" },
                  { value: "newline", label: "Shift+Enter submits" },
                ]}
              />
            </div>

            {/* Live legend: exactly what each key combination does under the
                current choices. Updates as the groups change (driven off the
                same `editorSettings` snapshot). */}
            <div className="settings-session-card-key-legend">
              {submitKeyLegend(
                editorSettings.returnKeyAction,
                editorSettings.numpadEnterAction,
              ).map(({ key, effect }) => (
                <TugLabel key={key} size="sm" emphasis="calm">
                  {`• ${key} ${effect}`}
                </TugLabel>
              ))}
            </div>
          </div>
        </TugBox>

        <TugBox
          label="AI Model"
          labelPosition="legend"
          variant="bordered"
          className="settings-session-card-group"
        >
          {/* Defaults new cards adopt on first open — a card already carrying
              its own remembered value keeps it. The mixer's editor itself,
              on the page: a panel whose whole job is showing settings has no
              business hiding three of them behind a button, and the scope
              line is the one thing it says differently from the sheet. */}
          <div className="settings-session-card-ai">
            <AiConfigEditor
              sources={aiSources}
              value={aiSources.value}
              onChange={onAiChange}
              scopeNote="Defaults for new sessions. Existing sessions keep their settings."
              focusGroup={aiFocusGroup}
            />
          </div>
        </TugBox>
      </div>
    </ResponderScope>
  );
}
