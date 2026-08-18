/**
 * spike-focus-language.tsx — the canonical reference for the keyboard-focus
 * visual language.
 *
 * One static screen showing the whole language across the component-archetype
 * taxonomy, in BOTH themes (toggle brio/harmony in the gallery chrome). Every
 * state (rest / mouse-hover / keyboard-cursor / selected) is forced via a
 * self-contained `data-fl-*` attribute so all of them show at once for
 * comparison — this is the OVERVIEW; per-component keyboard vetting on the real
 * engine lives in each component card's "Focus Language" section.
 *
 * The shipped model (see tuglaws/focus-language.md for the governing contract):
 *   - keyboard focus = a RING + a faint BEHIND-TINT on the focused component;
 *   - committed selection = the component's NATIVE fill (dot / pill / fill);
 *   - buttons: the live (focused) button PROMOTES to its filled role style; a
 *     scope's recommended-default rests at a TINT + ring (full fill is reserved
 *     for selection + the live control);
 *   - one ROLE AXIS, default action: ring + fill + tint all resolve from it;
 *   - motion is two planes: Tab moves the key view (linear), arrows move the
 *     cursor within a focused group (spatial); commit is a separate act (Space
 *     commits the ringed item, Enter is the scope default).
 *
 * Laws: [L06] appearance is attribute → CSS (here forced reference attributes, no
 * React-driven style); [L19] gallery-card authoring.
 */

import "./spike.css";
import type { SpikeDef } from "./spike-registry";
import "./spike-focus-language.css";

import React from "react";

import { TugLabel } from "@/components/tugways/tug-label";

type Branch = "fill" | "ring";

function SectionHead({
  title,
  branch,
  note,
}: {
  title: string;
  branch: Branch;
  note: string;
}): React.ReactElement {
  return (
    <div className="fl-section-head">
      <div className="fl-section-title">
        {title}
        <span className="fl-branch-tag" data-branch={branch}>
          {branch === "fill" ? "FILL" : "RING"}
        </span>
      </div>
      <div className="fl-note">{note}</div>
    </div>
  );
}

function Cell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="fl-cell">
      <div className="fl-stage">{children}</div>
      <div className="fl-cell-label">{label}</div>
    </div>
  );
}

/** A role button mockup at a forced state. */
function Btn({
  role,
  state,
  label,
}: {
  role: "action" | "danger" | "accent";
  state?: "hover" | "cursor" | "default";
  label: string;
}): React.ReactElement {
  return (
    <span className="fl-btn" data-role={role} data-fl-state={state}>
      {label}
    </span>
  );
}

export function SpikeFocusLanguage(): React.ReactElement {
  return (
    <div className="sp-content sp-focus-language" data-testid="gallery-focus-language">
      <TugLabel className="sp-section-title">
        Focus Language — the keyboard-focus treatment across the component-archetype
        taxonomy. Toggle the theme to see both. Each row shows the component's states
        (rest / hover / keyboard-cursor / selected) and its role colouring.
      </TugLabel>

      {/* ---------- Motion model: two planes + explicit commit ---------- */}
      <div className="fl-section">
        <SectionHead
          title="Motion — two planes, explicit commit"
          branch="ring"
          note="Keyboard motion is two independent planes. Tab (and Shift-Tab) moves the KEY VIEW linearly through the focusable stops of the current focus mode. Within a focused item-group, the arrows move a CURSOR spatially over the members (author-declared rings + seams, not geometry). Committing is a separate act: Space commits the ringed member, Enter fires the scope's default. Arrows never select. A capturing control (a text editor) suspends the arrow plane; Tab or Escape returns to it."
        />
        <div className="fl-grid">
          <Cell label="ring on the cursor (no commit)">
            <Group focus selected={0} cursor={1} />
          </Cell>
          <Cell label="text field — captures arrows">
            <span className="fl-input" data-fl-state="cursor">
              caret here
            </span>
          </Cell>
        </div>
      </div>

      {/* ---------- 1. Role button ---------- */}
      <div className="fl-section">
        <SectionHead
          title="1 · Role button"
          branch="fill"
          note="A pure action control has no separate 'selected' state, so the cursor can take over the FILL: the live (focused) button promotes to its filled role style + a role-coloured ring; siblings demote to outlined. Solid fill is reserved for selection + the live control — a scope's recommended-default (the button Return fires, when the cursor rests elsewhere) instead rests at a TINT with a ring (`persistentDefaultRing`). Covers TugPushButton, TugIconButton, TugDialogButton, TugPopupButton."
        />
        <div className="fl-grid">
          <Cell label="rest (outlined)">
            <Btn role="action" label="Allow" />
          </Cell>
          <Cell label="mouse-hover">
            <Btn role="action" state="hover" label="Allow" />
          </Cell>
          <Cell label="recommended default (tint + ring)">
            <Btn role="action" state="default" label="Allow" />
          </Cell>
          <Cell label="live / focused (filled + ring)">
            <Btn role="action" state="cursor" label="Allow" />
          </Cell>
          <Cell label="kbd-cursor (danger)">
            <Btn role="danger" state="cursor" label="Delete" />
          </Cell>
          <Cell label="kbd-cursor (accent)">
            <Btn role="accent" state="cursor" label="Save" />
          </Cell>
        </div>
        <div className="fl-grid" style={{ marginTop: "16px" }}>
          <Cell label="group — keyboard on Allow (Deny demoted)">
            <span className="fl-btn-group">
              <Btn role="danger" label="Deny" />
              <Btn role="action" state="cursor" label="Allow" />
            </span>
          </Cell>
          <Cell label="group — keyboard on Deny (Allow demoted)">
            <span className="fl-btn-group">
              <Btn role="danger" state="cursor" label="Deny" />
              <Btn role="action" label="Allow" />
            </span>
          </Cell>
        </div>
      </div>

      {/* ---------- 2. Text input ---------- */}
      <div className="fl-section">
        <SectionHead
          title="2 · Text input"
          branch="ring"
          note="Can't fill — a filled body destroys legibility of typed text. So focus is a DOUBLE border: the field's own border recolours to the role colour + an offset outer ring. Input is role-less by default (action-blue), but its VALIDATION state maps onto the role axis — an invalid field is the danger role, so it focuses red (last cell). Covers TugInput, TugTextarea, TugValueInput, and caret editors (prompt, code/markdown)."
        />
        <div className="fl-grid">
          <Cell label="rest">
            <span className="fl-input">name@host</span>
          </Cell>
          <Cell label="mouse-hover">
            <span className="fl-input" data-fl-state="hover">
              name@host
            </span>
          </Cell>
          <Cell label="kbd-cursor (double border)">
            <span className="fl-input" data-fl-state="cursor">
              name@host
            </span>
          </Cell>
          <Cell label="invalid → danger role · kbd">
            <span className="fl-input" data-fl-role="danger" data-fl-state="cursor">
              not-an-email
            </span>
          </Cell>
        </div>
      </div>

      {/* ---------- 3. Small toggle ---------- */}
      <div className="fl-section">
        <SectionHead
          title="3 · Small toggle"
          branch="ring"
          note="The COMPLETE control is the glyph PLUS its label — so keyboard focus rings the WHOLE component (box and label together), never just the box. Checked is a FILL on the box. The two are orthogonal: a ring says 'the keyboard is here', a fill says 'this is on'. These controls support ROLES, so both the fill and the focus ring take the role colour (bottom row: danger / accent); role-less controls fall back to action-blue. Covers TugCheckbox, TugSwitch."
        />
        <div className="fl-grid">
          <Cell label="unchecked · rest">
            <CheckField label="Enable telemetry" />
          </Cell>
          <Cell label="unchecked · kbd (ring on whole)">
            <CheckField label="Enable telemetry" kbd />
          </Cell>
          <Cell label="checked · rest">
            <CheckField label="Enable telemetry" checked />
          </Cell>
          <Cell label="checked · kbd">
            <CheckField label="Enable telemetry" checked kbd />
          </Cell>
        </div>
        <div className="fl-grid" style={{ marginTop: "16px" }}>
          <Cell label="off · rest">
            <SwitchField label="Wrap lines" />
          </Cell>
          <Cell label="on · rest">
            <SwitchField label="Wrap lines" checked />
          </Cell>
          <Cell label="on · kbd (ring on whole)">
            <SwitchField label="Wrap lines" checked kbd />
          </Cell>
        </div>
        <div className="fl-grid" style={{ marginTop: "16px" }}>
          <Cell label="danger role · checked · kbd">
            <CheckField label="Delete on quit" checked kbd role="danger" />
          </Cell>
          <Cell label="accent role · on · kbd">
            <SwitchField label="Pin to top" checked kbd role="accent" />
          </Cell>
        </div>
      </div>

      {/* ---------- 4. Continuous / slider ---------- */}
      <div className="fl-section">
        <SectionHead
          title="4 · Continuous / slider"
          branch="ring"
          note="The COMPLETE control is the label + track + value readout. Keyboard focus rings the WHOLE component and FILLS the thumb solid (hollow at rest). There is no separate 'selected' — the value (the fill length) is the state; it just commits live as you move. Covers TugSlider and the SplitPane divider."
        />
        <div className="fl-grid">
          <Cell label="rest">
            <SliderField label="Volume" value="45%" pct={45} />
          </Cell>
          <Cell label="kbd-focus (ring + filled thumb)">
            <SliderField label="Volume" value="45%" pct={45} kbd />
          </Cell>
        </div>
      </div>

      {/* ---------- The one model — applied per component (5–9) ---------- */}
      <div className="fl-section">
        <SectionHead
          title="One model for item-groups (§5–§9)"
          branch="ring"
          note="Every group below obeys the same rule: keyboard focus tints BEHIND the whole component; the roving cursor is a RING around the current item (it sits just outside the item, so it survives on top of a selection fill — no extra checkmark); committing sets the NATIVE selection fill. What varies: cardinality — exclusive (one) vs multiple — and ROLE. Role-bearing components (checkbox/switch/radio/choice/option) colour BOTH the fill and the focus ring with the role (see the danger/accent cells); role-less components fall back to action-blue. Each component keeps its decades-old selection convention (dot / pill / fill)."
        />
      </div>

      {/* ---------- 5. RadioGroup (exclusive · dot) ---------- */}
      <div className="fl-section">
        <SectionHead
          title="5 · RadioGroup — exclusive"
          branch="ring"
          note="Native selection = the blue dot, one at a time. Component focus = the behind-tint; cursor = the ring; the two are independent."
        />
        <div className="fl-grid">
          <Cell label="rest (not focused)">
            <Group selected={0} />
          </Cell>
          <Cell label="focused — cursor on the selection (A)">
            <Group focus selected={0} cursor={0} />
          </Cell>
          <Cell label="focused — cursor roamed to B (A still selected)">
            <Group focus selected={0} cursor={1} />
          </Cell>
          <Cell label="danger role — fill + ring follow the role">
            <Group focus selected={0} cursor={0} role="danger" />
          </Cell>
        </div>
      </div>

      {/* ---------- 6. ChoiceGroup / TabBar (exclusive · pill) ---------- */}
      <div className="fl-section">
        <SectionHead
          title="6 · ChoiceGroup / TabBar — exclusive"
          branch="ring"
          note="Native selection = a SOLID blue segment, one at a time. Same model: behind-tint on focus, ring on the cursor segment, fill on the selected segment. (TugTabBar is folded in here as commit-on-act, dropping its old live-commit special case.)"
        />
        <div className="fl-grid">
          <Cell label="rest — Alpha selected">
            <Tabs selected={0} />
          </Cell>
          <Cell label="focused — cursor on Beta (Alpha selected)">
            <Tabs focus selected={0} cursor={1} />
          </Cell>
          <Cell label="focused — act → Gamma selected">
            <Tabs focus selected={2} cursor={2} />
          </Cell>
          <Cell label="accent role — fill + ring follow the role">
            <Tabs focus selected={0} cursor={1} role="accent" />
          </Cell>
        </div>
      </div>

      {/* ---------- 7. OptionGroup (multiple · fill) ---------- */}
      <div className="fl-section">
        <SectionHead
          title="7 · OptionGroup — multiple"
          branch="ring"
          note="Native selection = a solid fill, MANY at a time. Identical model — and here the ring-cursor pays off: when it lands on an already-checked item the ring rides on top of the fill, staying visible with no added checkmark."
        />
        <div className="fl-grid">
          <Cell label="rest — B + C checked">
            <OptionSet selected={[1, 2]} />
          </Cell>
          <Cell label="focused — cursor on unchecked A">
            <OptionSet focus selected={[1, 2]} cursor={0} />
          </Cell>
          <Cell label="focused — cursor on a checked item (C)">
            <OptionSet focus selected={[1, 2]} cursor={2} />
          </Cell>
          <Cell label="danger role — fill + ring follow the role">
            <OptionSet focus selected={[1, 2]} cursor={2} role="danger" />
          </Cell>
        </div>
      </div>

      {/* ---------- 8. Descendable rows ---------- */}
      <div className="fl-section">
        <SectionHead
          title="8 · Descendable rows — list / accordion (multiple)"
          branch="ring"
          note="Rings mark elements, washes mark containers — clearest here, where the container is big. The focused list takes a background WASH and no stroke of any kind; the cursor row takes a leading-edge BAR, not a ring, because a ring around a full-bleed row reads as a second container nested in the first. Selection stays the native row fill (multi-capable). Plus the descend story: when the keyboard descends INTO a row, the container keeps its FULL wash rather than dropping to the quiet 'contains active' mark — a descend goes deeper into the list, not out of it, and the wash is what says which list the descended control belongs to. Covers TugListView, TugListRow, TugAccordion, transcript/body-kind blocks."
        />
        <div className="fl-grid">
          <Cell label="focused — cursor on row 2 (row 1 selected)">
            <ListRows focus selected={0} cursor={1} />
          </Cell>
          <Cell label="descended — container 'within' mark">
            <ListRows selected={1} within />
          </Cell>
        </div>
      </div>

      {/* ---------- 9. QuestionDialog answers ---------- */}
      <div className="fl-section">
        <SectionHead
          title="9 · QuestionDialog answers — exclusive & multi"
          branch="ring"
          note="The dialog's answer list is the same item-group model. An exclusive question uses radio rows (one answer); a multi-select question uses checkbox rows (several). Both get the behind-tint on focus and the ring on the cursored answer; selection is the native radio dot / checkbox."
        />
        <div className="fl-grid">
          <Cell label="exclusive — focused, cursor on B (A chosen)">
            <QAnswers mode="exclusive" focus selected={[0]} cursor={1} />
          </Cell>
          <Cell label="multi — focused, cursor on a chosen answer (A)">
            <QAnswers mode="multi" focus selected={[0, 2]} cursor={0} />
          </Cell>
        </div>
      </div>

      {/* ---------- 10. Component box-scope ---------- */}
      <div className="fl-section">
        <SectionHead
          title="10 · Component box-scope"
          branch="ring"
          note="A whole container becomes the key view (popover / sheet / alert / inline-dialog box). It can't fill, so it wears a box-shadow ring that hugs the radius with no reflow, and the quiet 'within' variant when it merely contains the active control. Covers TugPopover, TugSheet, TugAlert, the inline-dialog shell."
        />
        <div className="fl-grid">
          <Cell label="rest">
            <span className="fl-box">Popover content</span>
          </Cell>
          <Cell label="kbd key-view (ring)">
            <span className="fl-box" data-fl-state="cursor">
              Popover content
            </span>
          </Cell>
          <Cell label="contains-active (within)">
            <span className="fl-box" data-fl-state="within">
              Popover content
            </span>
          </Cell>
        </div>
      </div>

      {/* ---------- 11. Inline link ---------- */}
      <div className="fl-section">
        <SectionHead
          title="11 · Inline link (long tail)"
          branch="ring"
          note="The long tail: inline, non-box focusables that can't ring cleanly or fill. They underline on hover, and underline + a keyboard-coloured ring on cursor. Covers TugLink and arbitrary focusable content."
        />
        <div className="fl-grid">
          <Cell label="rest">
            <span>
              See the <span className="fl-link">documentation</span> for details.
            </span>
          </Cell>
          <Cell label="mouse-hover">
            <span>
              See the{" "}
              <span className="fl-link" data-fl-state="hover">
                documentation
              </span>{" "}
              for details.
            </span>
          </Cell>
          <Cell label="kbd-cursor">
            <span>
              See the{" "}
              <span className="fl-link" data-fl-state="cursor">
                documentation
              </span>{" "}
              for details.
            </span>
          </Cell>
        </div>
      </div>
    </div>
  );
}

/* ---------- mockup sub-components ---------- */

/** A role applied to a role-bearing control — colours its fill AND its focus
 *  ring. Omit for the default (the blue selection axis / action ring). */
type FlRole = "danger" | "accent";

/** A complete checkbox control — box + label — with the keyboard ring around
 *  the whole field (not just the box). */
function CheckField({
  label,
  checked,
  kbd,
  role,
}: {
  label: string;
  checked?: boolean;
  kbd?: boolean;
  role?: FlRole;
}): React.ReactElement {
  return (
    <span
      className="fl-toggle-field"
      data-fl-state={kbd ? "cursor" : undefined}
      data-fl-role={role}
    >
      <span className="fl-check" data-checked={checked ? "true" : undefined}>
        {checked ? "✓" : ""}
      </span>
      <span>{label}</span>
    </span>
  );
}

/** A complete switch control — track + label — ringed as a whole on keyboard
 *  focus. */
function SwitchField({
  label,
  checked,
  kbd,
  role,
}: {
  label: string;
  checked?: boolean;
  kbd?: boolean;
  role?: FlRole;
}): React.ReactElement {
  return (
    <span
      className="fl-toggle-field"
      data-fl-state={kbd ? "cursor" : undefined}
      data-fl-role={role}
    >
      <span className="fl-switch" data-checked={checked ? "true" : undefined} />
      <span>{label}</span>
    </span>
  );
}

/** A complete slider control — label + track + value readout — ringed as a
 *  whole on keyboard focus, with the thumb filled solid when focused. */
function SliderField({
  label,
  value,
  pct,
  kbd,
}: {
  label: string;
  value: string;
  pct: number;
  kbd?: boolean;
}): React.ReactElement {
  return (
    <span className="fl-slider-field" data-fl-state={kbd ? "cursor" : undefined}>
      <span className="fl-slider-head">
        <span>{label}</span>
        <span className="fl-slider-value">{value}</span>
      </span>
      <span className="fl-track">
        <span className="fl-fill" style={{ width: `${pct}%` }} />
        <span className="fl-thumb" style={{ left: `${pct}%` }} />
      </span>
    </span>
  );
}

/* Every item-group below takes `focus` (→ the behind-tint on the container),
   `cursor` (→ the ring on one item), and a `selected` set (→ native fill). */

const GROUP_ITEMS = ["Allow once", "Allow always", "Allow for session"];

function Group({
  focus,
  selected,
  cursor,
  role,
}: {
  focus?: boolean;
  selected?: number;
  cursor?: number;
  role?: FlRole;
}): React.ReactElement {
  return (
    <div
      className="fl-group"
      data-fl-focus={focus ? "true" : undefined}
      data-fl-role={role}
    >
      {GROUP_ITEMS.map((label, i) => (
        <div
          key={label}
          className="fl-item"
          data-fl-selected={selected === i ? "true" : undefined}
          data-fl-cursor={cursor === i ? "true" : undefined}
        >
          <span className="fl-dot" />
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

const TAB_ITEMS = ["Alpha", "Beta", "Gamma"];

function Tabs({
  focus,
  selected,
  cursor,
  role,
}: {
  focus?: boolean;
  selected: number;
  cursor?: number;
  role?: FlRole;
}): React.ReactElement {
  return (
    <div
      className="fl-tabs"
      data-fl-focus={focus ? "true" : undefined}
      data-fl-role={role}
    >
      {TAB_ITEMS.map((label, i) => (
        <span
          key={label}
          className="fl-tab"
          data-fl-selected={selected === i ? "true" : undefined}
          data-fl-cursor={cursor === i ? "true" : undefined}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

const OPTION_ITEMS = ["Logs", "Telemetry", "Network"];

function OptionSet({
  focus,
  selected,
  cursor,
  role,
}: {
  focus?: boolean;
  selected: readonly number[];
  cursor?: number;
  role?: FlRole;
}): React.ReactElement {
  return (
    <div
      className="fl-optset"
      data-fl-focus={focus ? "true" : undefined}
      data-fl-role={role}
    >
      {OPTION_ITEMS.map((label, i) => (
        <span
          key={label}
          className="fl-opt"
          data-fl-selected={selected.includes(i) ? "true" : undefined}
          data-fl-cursor={cursor === i ? "true" : undefined}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

const LIST_ITEMS = ["README.md", "package.json", "tsconfig.json"];

function ListRows({
  focus,
  selected,
  cursor,
  within,
}: {
  focus?: boolean;
  selected?: number;
  cursor?: number;
  within?: boolean;
}): React.ReactElement {
  return (
    <div
      className="fl-list"
      data-fl-focus={focus ? "true" : undefined}
      data-fl-within={within ? "true" : undefined}
    >
      {LIST_ITEMS.map((label, i) => (
        <div
          key={label}
          className="fl-list-row"
          data-fl-selected={selected === i ? "true" : undefined}
          data-fl-cursor={cursor === i ? "true" : undefined}
        >
          {label}
        </div>
      ))}
    </div>
  );
}

const QA_ITEMS = ["Rebase onto main", "Merge with a commit", "Squash and merge"];

/** QuestionDialog answer list — exclusive (radio rows) or multi (checkbox rows),
 *  under the same item-group model. */
function QAnswers({
  mode,
  focus,
  selected,
  cursor,
}: {
  mode: "exclusive" | "multi";
  focus?: boolean;
  selected: readonly number[];
  cursor?: number;
}): React.ReactElement {
  return (
    <div className="fl-qa" data-fl-focus={focus ? "true" : undefined}>
      {QA_ITEMS.map((label, i) => {
        const isSelected = selected.includes(i);
        return (
          <div
            key={label}
            className="fl-qa-row"
            data-fl-cursor={cursor === i ? "true" : undefined}
          >
            {mode === "exclusive" ? (
              <span
                className="fl-dot"
                data-fl-selected={isSelected ? "true" : undefined}
              />
            ) : (
              <span className="fl-check" data-checked={isSelected ? "true" : undefined}>
                {isSelected ? "✓" : ""}
              </span>
            )}
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

export const spike: SpikeDef = {
  name: "focus-language",
  title: "Focus Language",
  blurb: "The canonical reference for the keyboard-focus visual language: every ring, every state.",
  icon: "Focus",
  // This spike's subject IS the engine's focus stops, so it has to read with
  // rings on at rest rather than only once the keyboard drives.
  kbfAtRest: true,
  component: () => <SpikeFocusLanguage />,
};
