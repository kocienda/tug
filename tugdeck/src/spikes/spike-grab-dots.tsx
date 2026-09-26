/**
 * spike-grab-dots.tsx — the grab-dot field: two or three rows of identical 1px
 * dots filling the run between a card's title and its `…`, on card hover.
 *
 * Most of the configuration is settled and is what the spike shows rather than
 * what it asks about:
 *
 *   FILL          the field takes the whole run, title's end to the controls
 *   CARD HOVER    nothing at rest; the field arrives when the pointer enters
 *                 the card — not merely the title bar
 *   1px DOT       one size, always. The grid may change; the dot does not
 *   4px PITCH     the grid
 *   0.5px LIFT    the nudge that puts the field on the name's optical center
 *
 * One thing is still open, and it is the section the spike now leads with:
 *
 *   ROWS          two or three. Same dot, same pitch, same lift; the block-size
 *                 is derived as `(rows - 1) x pitch + dot`, so two rows is 5px
 *                 and three is 9px at the 4px pitch
 *
 * ── Why 0.5px is a real number and not a rounding error ──
 * The field centers on the flex line and the title does not: a line of text
 * centers on its LINE BOX, whose lower half is descender space the name mostly
 * leaves empty, so the word's optical center sits above the geometric one. The
 * correction wanted is smaller than a CSS pixel. On a 2× display 0.5px is
 * exactly one device pixel — the smallest honest correction there is, and it
 * lands the dot stencil back ON the pixel grid rather than off it. On a 1×
 * display it is half a device pixel and the rows soften. The deck does not ask
 * what it is running on, so that is a fact to know before this ships rather
 * than a bug in the value.
 *
 * ── Why the dots are now identical ──
 * The previous pass drew a repeating background tile with a disc in it, which
 * is the ordinary way to draw a dot grid and is why the dots did not all look
 * the same size. A repeated background is composited tile by tile with each
 * tile's device rect rounded independently, and the field never starts on a
 * device pixel — it is a flex item sitting after a run of text. So neighbouring
 * dots rounded in different directions: one landed on the grid and rendered as
 * clean ink, the next landed on the half and rendered as two columns at half
 * coverage, which reads as a bigger, softer, fainter dot. A 1px circle makes it
 * worse, being a curve sampled at one pixel and therefore entirely
 * antialiasing.
 *
 * The field is now a solid ink box masked to 1px SQUARES by two crossed
 * hard-edged gradients composited with `mask-composite: intersect`. Each
 * gradient paints once across the whole box — no tiles, so no per-tile
 * rounding; no curve, so no antialiasing of the shape. Every dot shares one
 * subpixel phase and rasterizes the same. The full argument is in
 * `spike-grab-dots.css`; the *evidence* is the inspection strip below, which is
 * why that section exists.
 *
 * ── What hover costs, said once ──
 * A mark nobody sees at rest cannot teach anybody the card is draggable. Card
 * hover buys back most of that — you cross a card long before you reach its
 * title bar — which is the argument for the card trigger over the bar trigger,
 * and the reason the bar is kept here only as a comparison.
 *
 * The field is faded, never removed. It holds its space in the flex line at all
 * times and only its opacity changes, so the title's measure and elision point
 * are identical hovered and not. The cost of that is real and visible in the
 * long-title row: a long name elides earlier than it does today even at rest,
 * because the space is held whether or not anything is drawn in it.
 *
 * ── The `…` ──
 * The field runs up to the control cluster, and the `…` is three dots in ONE
 * row a few pixels away. Being a BLOCK of dots where the button is a LINE of
 * them is the whole discriminator, which is why the row count is a real design
 * question rather than a taste one: three rows makes the distinction easier to
 * keep and costs more ink to keep it. The height is derived from the pitch at
 * either setting, so the field can never cut a partial row and hand the button
 * its argument back. The last section puts both counts beside the glyph,
 * magnified.
 *
 * Everything on display is the real chrome — a real `CardTitleBar` inside a
 * real `.tug-pane` — so the focus token pairs, the controls-width reserve the
 * masthead's lines measure, and the deck's inactive recede are the shipping
 * ones. No rule here touches a rail: a rail is pinned to a deck edge and is not
 * dragged by its bar, so a drag affordance has no business on one. Each section
 * carries a real rail to show the mark stays off it.
 *
 * @module spikes/spike-grab-dots
 */

import React, { useId, useState } from "react";

import { CardTitleBar } from "@/components/chrome/tug-pane";
import type { DocumentMastheadPayload } from "@/lib/card-title-store";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TugBox } from "@/components/tugways/tug-box";
import { TugCheckbox } from "@/components/tugways/tug-checkbox";
import { useResponderForm } from "@/components/tugways/use-responder-form";

import "./spike.css";
import type { SpikeDef } from "./spike-registry";
import "./spike-grab-dots.css";

// ---------------------------------------------------------------------------
// Fixture content
// ---------------------------------------------------------------------------

const SESSION_PATH = "/Users/kocienda/Mounts/u/src/tug";

/** The card in the screengrab this spike came from. */
const SESSION_MASTHEAD: DocumentMastheadPayload = {
  kind: "card-masthead",
  icon: "CircleDot",
  title: "tug/waxen-vixen",
  description: "Spike a drag-affordance stripe distinguishing content and sidebar cards",
  detail: "1 turn, 569 KB. Last updated: Sep 26, 4:01 AM. Ready.",
};

/**
 * A name long enough to eat most of the run. Filling the run takes the title's
 * flex-grow away, so the title elides against what the field leaves it rather
 * than against the whole line — at rest as much as on hover, because the field
 * holds its space either way. This row is where that cost is visible, along
 * with the field's `min-inline-size` floor that stops it collapsing to a sliver.
 */
const LONG_MASTHEAD: DocumentMastheadPayload = {
  kind: "card-masthead",
  icon: "FileText",
  title: "session-naming-notes-and-open-questions-2026-09.md",
  description: `${SESSION_PATH}/briefs/session-naming-notes-and-open-questions-2026-09.md`,
  descriptionKind: "path",
  detail: "Markdown · manual save · UTF-8 · 1,284 words",
};

// ---------------------------------------------------------------------------
// Fixture frame
// ---------------------------------------------------------------------------

/**
 * The chrome's own wrapper, not a stand-in for it: `.tug-pane` is where
 * `--tugx-pane-controls-width` is published — which the masthead's lead line
 * reserves against, and which therefore decides where the run the field fills
 * actually ends — and `.tug-pane-chrome` is where the deck's two-layer inactive
 * recede lives. `.tug-pane` is also the card-hover trigger's hit area, so the
 * trigger under test is the real element's and not a fixture's approximation.
 */
function SpikePane({
  focused,
  masthead = false,
  children,
  body,
}: {
  focused: boolean;
  masthead?: boolean;
  children: React.ReactNode;
  body: string;
}) {
  return (
    <div
      className="tug-pane sp-dots-pane"
      data-focused={focused ? "true" : undefined}
      data-masthead={masthead ? "true" : undefined}
    >
      <div className="tug-pane-chrome">
        {children}
        <div className="sp-dots-pane-body">{body}</div>
      </div>
    </div>
  );
}

const noop = () => {
  /* spike: the chrome is the subject, its actions are not */
};

/** The document tier — the card in the screengrab, and the case that matters. */
function MastheadCard({
  focused,
  payload,
  body,
}: {
  focused: boolean;
  payload: DocumentMastheadPayload;
  body: string;
}) {
  return (
    <SpikePane focused={focused} masthead body={body}>
      <CardTitleBar
        title={payload.title}
        masthead={payload}
        widthPreset="comfy"
        onSetWidth={noop}
        onClose={noop}
      />
    </SpikePane>
  );
}

/** The utility tier — a 36px bar, where the run is a plain flex gap. */
function UtilityCard({ focused }: { focused: boolean }) {
  return (
    <SpikePane focused={focused} body="Appearance · Editor · Sessions">
      <CardTitleBar
        title="Settings"
        icon="Settings"
        widthPreset="comfy"
        onSetWidth={noop}
        onClose={noop}
      />
    </SpikePane>
  );
}

/** The control. No rule in this spike touches a rail, and this proves it. */
function RailCard({ focused }: { focused: boolean }) {
  return (
    <SpikePane focused={focused} body="Cards · Layouts · Sessions">
      <CardTitleBar title="Lens" icon="Microscope" sidebar onClose={noop} />
    </SpikePane>
  );
}

function Cell({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="sp-dots-cell">
      <TugLabel size="2xs" emphasis="calm">
        {caption}
      </TugLabel>
      {children}
    </div>
  );
}

function RadioRow({
  label,
  name,
  options,
  value,
  onChange,
}: {
  label: string;
  name: string;
  options: readonly { key: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="sp-dots-radio-row">
      <TugLabel size="2xs" emphasis="calm">
        {label}
      </TugLabel>
      {options.map((option) => (
        <label key={option.key} className="sp-dots-radio">
          <input
            type="radio"
            name={name}
            checked={value === option.key}
            onChange={() => onChange(option.key)}
          />
          <TugLabel size="2xs">{option.label}</TugLabel>
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SpikeGrabDots
// ---------------------------------------------------------------------------

export function SpikeGrabDots(): React.ReactElement {
  const [focused, setFocused] = useState(true);
  const [pinned, setPinned] = useState(false);
  const [lift, setLift] = useState("0.5");
  const [pitch, setPitch] = useState("4");
  const [rows, setRows] = useState("3");
  const [trigger, setTrigger] = useState("card");

  const focusedId = useId();
  const pinnedId = useId();

  const { ResponderScope, responderRef } = useResponderForm({
    toggle: {
      [focusedId]: setFocused,
      [pinnedId]: setPinned,
    },
  });

  return (
    <ResponderScope>
      <div
        className="sp-content sp-dots"
        data-lift={lift}
        data-pitch={pitch}
        data-rows={rows}
        data-trigger={trigger}
        data-pinned={pinned ? "true" : undefined}
        data-testid="spike-grab-dots"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <div className="sp-section">
          <TugLabel className="sp-section-title">
            Grab dots — 1px dot, 4px pitch, 0.5px lift, on card hover. Two rows or three?
          </TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            Nothing at rest. Move the pointer anywhere onto a card below — not just its
            title bar — and the field fills the run between the title and the{" "}
            <code>…</code>. The dot is one size at every pitch and has no variant rule
            anywhere; what changed since the last pass is not the value but the{" "}
            <em>drawing</em>, which is what the inspection strip is for. No rail wears the
            mark: a rail is pinned to a deck edge and is not dragged by its bar, so each
            section carries one to show it stays off.
          </TugLabel>
        </div>

        <TugSeparator />

        <div className="sp-section">
          <TugLabel className="sp-section-title">Preview controls</TugLabel>
          <TugBox
            variant="bordered"
            rounded="sm"
            style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: "10px" }}
          >
            <div className="sp-dots-radio-row">
              <TugCheckbox checked={focused} senderId={focusedId} label="Pane focused" size="sm" />
              <TugCheckbox
                checked={pinned}
                senderId={pinnedId}
                label="Pin visible (no pointer needed)"
                size="sm"
              />
            </div>
            <RadioRow
              label="Lift"
              name="sp-dots-lift"
              value={lift}
              onChange={setLift}
              options={[
                { key: "0", label: "0" },
                { key: "0.5", label: "0.5px" },
                { key: "1", label: "1px" },
                { key: "2", label: "2px" },
              ]}
            />
            <RadioRow
              label="Pitch"
              name="sp-dots-pitch"
              value={pitch}
              onChange={setPitch}
              options={[
                { key: "3", label: "3px" },
                { key: "4", label: "4px" },
                { key: "5", label: "5px" },
              ]}
            />
            <RadioRow
              label="Rows"
              name="sp-dots-rows"
              value={rows}
              onChange={setRows}
              options={[
                { key: "2", label: "Two" },
                { key: "3", label: "Three" },
              ]}
            />
            <RadioRow
              label="Trigger"
              name="sp-dots-trigger"
              value={trigger}
              onChange={setTrigger}
              options={[
                { key: "card", label: "Hover the card" },
                { key: "bar", label: "Hover the title bar" },
              ]}
            />
          </TugBox>
          <TugLabel size="2xs" emphasis="calm">
            The settled values are the defaults; the neighbours are here to confirm the
            choice rather than to reopen it. <strong>Lift 0.5px</strong> is one device
            pixel on a 2× display — the smallest honest correction, and the one that lands
            the stencil back on the pixel grid. On a 1× display it is half a device pixel
            and the rows soften; the deck does not ask what it is running on, so that is
            worth knowing before this ships. <strong>Pin visible</strong> holds the field
            up without a pointer, which is the only way to read several cards at once.
          </TugLabel>
        </div>

        {/* ---- The mark, live ---- */}
        <TugSeparator />
        <div className="sp-section">
          <TugLabel className="sp-section-title">The mark</TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            Hover anywhere on a card.
          </TugLabel>

          <Cell caption="Document card — the masthead from the screengrab">
            <MastheadCard
              focused={focused}
              payload={SESSION_MASTHEAD}
              body="1  Assistant: Let me look at how cards are structured…"
            />
          </Cell>

          <div className="sp-dots-row">
            <Cell caption="Long title — where filling the run costs the title its measure">
              <MastheadCard focused={focused} payload={LONG_MASTHEAD} body="1  Notes:" />
            </Cell>
            <Cell caption="Utility card — 36px, the run is a plain flex gap">
              <UtilityCard focused={focused} />
            </Cell>
            <Cell caption="Rail — untouched (the control)">
              <RailCard focused={focused} />
            </Cell>
          </div>
        </div>

        {/* ---- Rows ---- */}
        <TugSeparator />
        <div className="sp-section">
          <TugLabel className="sp-section-title">Two rows or three</TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            Same dot, same pitch, same lift — the row count is the only difference. Each
            card below pins its own, so turn <strong>Pin visible</strong> on to read them
            together; the <strong>Rows</strong> control above drives the rest of the spike
            once you have picked. The field&apos;s height is derived as{" "}
            <code>(rows − 1) × pitch + dot</code>, so three rows is 9px at the 4px pitch
            against two rows&apos; 5px.
          </TugLabel>

          <div className="sp-dots-variant" data-rows-pin="2">
            <Cell caption="Two rows — 5px">
              <MastheadCard
                focused={focused}
                payload={SESSION_MASTHEAD}
                body="1  Assistant: Let me look at how cards are structured…"
              />
            </Cell>
          </div>

          <div className="sp-dots-variant" data-rows-pin="3">
            <Cell caption="Three rows — 9px">
              <MastheadCard
                focused={focused}
                payload={SESSION_MASTHEAD}
                body="1  Assistant: Let me look at how cards are structured…"
              />
            </Cell>
          </div>

          <TugLabel size="2xs" emphasis="calm">
            What to weigh. Three rows is further from the <code>…</code>, which is one row
            — the block reads less like a line of dots that button spilled, so the
            distinction the mark has to keep is easier to keep. It is also more ink in the
            run and a taller object on a 13px line: at 9px the field occupies most of the
            name&apos;s own height, so it stops reading as something sitting beside the
            title and starts reading as a band the title is set into. Two rows is the
            quieter mark and the one that stays subordinate to the name; three is the
            surer affordance.
          </TugLabel>

          <TugLabel size="2xs" emphasis="calm">
            The lift interacts, which is worth a second look rather than a rule: the nudge
            moves the field&apos;s box, and a taller box centered on the same line hangs
            lower before the nudge and sits further above after it. If three rows wins,
            step back through 0 and 0.5px before settling the lift.
          </TugLabel>
        </div>

        {/* ---- Uniformity ---- */}
        <TugSeparator />
        <div className="sp-section">
          <TugLabel className="sp-section-title">Every dot the same — the evidence</TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            The field at 8×. &ldquo;Every dot is the same size&rdquo; is a claim about
            rasterization, and a claim about rasterization cannot be checked at 1× — so
            this is the section that answers it rather than asserts it. Count along a row:
            every square should carry the same ink and the same edges, with no neighbour
            reading wider, softer or fainter than the one beside it.
          </TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            What the fix was: the previous pass tiled a 4×4 background with a 1px{" "}
            <em>circle</em> in it. A repeated background is composited tile by tile with
            each tile&apos;s device rect rounded on its own, and the field never begins on
            a device pixel — it is a flex item sitting after a run of text. So neighbouring
            dots rounded opposite ways, one landing clean and the next spread over two
            columns at half coverage, which reads as a larger fainter dot. A 1px circle is
            a curve sampled at one pixel and made that worse. The field is now a solid ink
            box masked to 1px <em>squares</em> by two crossed hard-edged gradients,
            intersected — painted once across the box, so there are no tiles to round and
            no curve to antialias, and every dot shares one phase.
          </TugLabel>

          <div className="sp-dots-zoom-strip">
            <div className="sp-dots-zoom" data-rows-pin="2">
              <TugLabel size="2xs" emphasis="calm">
                Two rows, 8×
              </TugLabel>
              <div className="sp-dots-zoom-stage" data-zoom="8">
                <div className="sp-dots-zoom-field" aria-hidden="true" />
              </div>
            </div>
            <div className="sp-dots-zoom" data-rows-pin="3">
              <TugLabel size="2xs" emphasis="calm">
                Three rows, 8×
              </TugLabel>
              <div className="sp-dots-zoom-stage" data-zoom="8">
                <div className="sp-dots-zoom-field" aria-hidden="true" />
              </div>
            </div>
          </div>

          <TugLabel size="2xs" emphasis="calm">
            One caveat, so this is not read as proving more than it does: zoom
            re-rasterizes at an integral scale from a fresh origin, which is a friendlier
            subpixel phase than the field gets inside a real title bar. This strip proves
            the <em>stencil</em> is uniform. The card rows above, at 1×, are what prove the
            phase does not spoil it.
          </TugLabel>
        </div>

        {/* ---- The adjacency ---- */}
        <TugSeparator />
        <div className="sp-section">
          <TugLabel className="sp-section-title">
            Against the <code>…</code>
          </TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            The field runs up to the control cluster, and the <code>…</code> is three dots
            in one row a few pixels away. The discriminator is that the field is a BLOCK
            of dots where the button is a LINE of them — the field&apos;s height is derived
            from the pitch at either row count, so it can never cut a partial row and hand
            the button its argument back. Both counts at 3×, with the real glyph beside
            them: look at whether the field reads as a block rather than as one thick line,
            and whether the air is enough that the two read as separate objects rather than
            as one control and its overflow. This is the comparison where three rows is
            likeliest to earn its extra ink.
          </TugLabel>

          <div className="sp-dots-zoom-strip">
            <div className="sp-dots-zoom" data-rows-pin="2">
              <TugLabel size="2xs" emphasis="calm">
                Two rows
              </TugLabel>
              <div className="sp-dots-zoom-stage" data-zoom="3">
                <div className="sp-dots-zoom-field" aria-hidden="true" />
                <div className="sp-dots-zoom-ellipsis" aria-hidden="true">
                  …
                </div>
              </div>
            </div>
            <div className="sp-dots-zoom" data-rows-pin="3">
              <TugLabel size="2xs" emphasis="calm">
                Three rows
              </TugLabel>
              <div className="sp-dots-zoom-stage" data-zoom="3">
                <div className="sp-dots-zoom-field" aria-hidden="true" />
                <div className="sp-dots-zoom-ellipsis" aria-hidden="true">
                  …
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "grab-dots",
  title: "Grab Dots",
  blurb:
    "Two or three rows of identical 1px dots filling the run between a card's title and its `…`, on card hover.",
  icon: "GripHorizontal",
  size: {
    min: { width: 520, height: 400 },
    preferred: { width: 900, height: 760 },
  },
  component: () => <SpikeGrabDots />,
};
