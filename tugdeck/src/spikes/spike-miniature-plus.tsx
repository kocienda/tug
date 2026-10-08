/**
 * spike-miniature-plus.tsx — plussing the Layout card's miniature.
 *
 * Two questions, asked against a mock of the Layout plate at its true size:
 *
 * 1. **What can a block say beyond "a card is here"?** Today every card is
 *    the same grey bar, so the picture states the arrangement and nothing
 *    about what is arranged. The first section draws one deck five ways —
 *    today's bars, then kind glyphs, tiny card faces, kind tints, and short
 *    labels — so the treatments can be compared at the size they would ship.
 *
 * 2. **Where should the stack/split toggle live?** It stands on the block
 *    today, at the foot of each slot. The second section tries the same
 *    toggle in three other homes: a glyph row under the numbered pills, a
 *    two-storey pill that carries both the number and the glyph, and one
 *    segmented control for the column the reader is in.
 *
 * The glyph buttons are live: pressing one flips that slot between stack and
 * split in the drawing above it, which is the whole gesture being relocated.
 *
 * The mock deck is the one in the screenshot that prompted this: a left rail
 * of three, four slots under Flow, a right rail of two, the window over the
 * leading pair — with slot 2 stacked three deep and slot 4 split in two, so
 * every treatment has a stack and a split to draw.
 *
 * @module spikes/spike-miniature-plus
 */

import "./spike.css";
import "./spike-miniature-plus.css";

import React, { useState } from "react";
import {
  Columns3,
  FileText,
  GitBranch,
  GitCompareArrows,
  LayoutGrid,
  MessageSquareText,
  Newspaper,
  NotebookPen,
  type LucideIcon,
} from "lucide-react";

import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import {
  SplitGlyph,
  StackGlyph,
} from "@/components/tugways/tug-column-badge";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { useMotionHold } from "@/lib/motion-guard";
import type { TugSlotState } from "@/components/tugways/tug-slot";
import { TugSlotLayout } from "@/components/tugways/tug-slot-layout";

import type { SpikeDef } from "./spike-registry";

/* ---------------------------------------------------------------------------
 * The mock deck
 * ---------------------------------------------------------------------------*/

type Kind =
  | "session"
  | "diff"
  | "file"
  | "workspaces"
  | "jots"
  | "layout"
  | "overview"
  | "arcs";

/** The icon each card kind registers — the same lucide names the registry
 *  carries in `defaultMeta.icon`, so this is a fact the drawing could read. */
const ICONS: Record<Kind, LucideIcon> = {
  session: MessageSquareText,
  diff: GitCompareArrows,
  file: FileText,
  workspaces: LayoutGrid,
  jots: NotebookPen,
  layout: Columns3,
  overview: Newspaper,
  arcs: GitBranch,
};

interface MockCard {
  kind: Kind;
  /** The two or three characters the Labels treatment draws. */
  label: string;
  /** A session with a turn in flight — the activity dot. */
  working?: boolean;
  /** The card the reader is in. */
  here?: boolean;
}

type Mode = "stack" | "split";

interface MockSlot {
  cards: MockCard[];
  mode: Mode;
}

const LEFT_RAIL: MockCard[] = [
  { kind: "workspaces", label: "W" },
  { kind: "jots", label: "J" },
  { kind: "layout", label: "L" },
];

const RIGHT_RAIL: MockCard[] = [
  { kind: "overview", label: "O" },
  { kind: "arcs", label: "A" },
];

const SLOTS: MockSlot[] = [
  { mode: "stack", cards: [{ kind: "session", label: "CA", working: true }] },
  {
    mode: "stack",
    cards: [
      { kind: "session", label: "OK", here: true },
      { kind: "diff", label: "Δ" },
      { kind: "file", label: ".md" },
    ],
  },
  { mode: "stack", cards: [{ kind: "session", label: "PW" }] },
  {
    mode: "split",
    cards: [
      { kind: "session", label: "TG" },
      { kind: "file", label: ".ts" },
    ],
  },
];

/** The window: the band covers the leading two slots. */
const WINDOW = { from: 0, to: 1 };

/** The slot the reader is in — the one the pills fill. */
const HERE_SLOT = SLOTS.findIndex((slot) => slot.cards.some((c) => c.here));

/* ---------------------------------------------------------------------------
 * Geometry — the plate's own numbers, restated
 * ---------------------------------------------------------------------------*/

/** The real plate: 300px at scale 0.7. */
const PLATE_WIDTH = 210;

/** A rail's share of the content box, and the seam between blocks. */
const RAIL_PCT = 13;
const GAP_PCT = 3.5;
const SEAM_PCT = 2.5;

function blockRects(count: number): { left: number; width: number }[] {
  const width = (100 - GAP_PCT * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => ({
    left: i * (width + GAP_PCT),
    width,
  }));
}

/* ---------------------------------------------------------------------------
 * The treatments
 * ---------------------------------------------------------------------------*/

type Treatment = "today" | "glyphs" | "faces" | "tinted" | "labels";

/** The in-flight dot; its pulse runs as long as it is mounted, so it holds
 *  motion for that long. */
function WorkingDot(): React.ReactElement {
  useMotionHold(true);
  return <span className="sp-mp-dot" />;
}

/** What one card's block carries, under a treatment. */
function CardContent({
  card,
  treatment,
  depth,
}: {
  card: MockCard;
  treatment: Treatment;
  /** How many cards stand behind this one in a stack; 0 for a lone card. */
  depth: number;
}): React.ReactElement | null {
  const Icon = ICONS[card.kind];
  switch (treatment) {
    case "today":
      return null;
    case "glyphs":
      return (
        <>
          <Icon className="sp-mp-icon" aria-hidden="true" />
          {depth > 0 ? <span className="sp-mp-count">{depth + 1}</span> : null}
        </>
      );
    case "faces":
      return (
        <>
          <span className="sp-mp-face-bar">
            {card.working ? <WorkingDot /> : null}
          </span>
          <Icon className="sp-mp-icon sp-mp-icon-face" aria-hidden="true" />
        </>
      );
    case "tinted":
      return null;
    case "labels":
      return <span className="sp-mp-label">{card.label}</span>;
  }
}

/** One slot's block — whole, or divided into its split members. The sheets a
 *  stack leaves peeking out are drawn behind the front card on the Faces
 *  treatment only; elsewhere depth is said by a count or not at all. */
function Block({
  slot,
  rect,
  treatment,
  showMark,
}: {
  slot: MockSlot;
  rect: { left: number; width: number };
  treatment: Treatment;
  /** Draw today's stack/split mark at the foot of the block. */
  showMark: boolean;
}): React.ReactElement {
  const divided = slot.mode === "split" && slot.cards.length > 1;
  const front = slot.cards[0];
  const depth = slot.cards.length - 1;
  const style = { left: `${rect.left}%`, width: `${rect.width}%` };
  const mark = showMark ? (
    <span className="sp-mp-mark">
      {slot.mode === "split" ? (
        <SplitGlyph lit={null} />
      ) : (
        <StackGlyph lit={null} />
      )}
    </span>
  ) : null;

  if (divided) {
    const n = slot.cards.length;
    const span = (100 - SEAM_PCT * (n - 1)) / n;
    return (
      <span className="sp-mp-slot" style={style}>
        {slot.cards.map((card, i) => (
          <span
            key={i}
            className="sp-mp-block"
            data-treatment={treatment}
            data-kind={card.kind}
            data-here={card.here ? "" : undefined}
            style={{
              top: `${i * (span + SEAM_PCT)}%`,
              height: `${span}%`,
            }}
          >
            <CardContent card={card} treatment={treatment} depth={0} />
          </span>
        ))}
        {mark}
      </span>
    );
  }

  return (
    <span className="sp-mp-slot" style={style}>
      {treatment === "faces" && depth > 0
        ? Array.from({ length: Math.min(depth, 2) }, (_, i) => (
            <span
              key={`sheet-${i}`}
              className="sp-mp-sheet"
              style={{ "--sheet": depth - i } as React.CSSProperties}
            />
          ))
        : null}
      <span
        className="sp-mp-block"
        data-treatment={treatment}
        data-kind={front.kind}
        data-here={front.here ? "" : undefined}
        data-stacked={depth > 0 && treatment === "faces" ? "" : undefined}
        style={{ top: 0, height: "100%" }}
      >
        <CardContent card={front} treatment={treatment} depth={depth} />
      </span>
      {mark}
    </span>
  );
}

function Rail({
  cards,
  treatment,
}: {
  cards: MockCard[];
  treatment: Treatment;
}): React.ReactElement {
  const n = cards.length;
  const span = (100 - SEAM_PCT * (n - 1)) / n;
  return (
    <span className="sp-mp-rail" style={{ flexBasis: `${RAIL_PCT}%` }}>
      {cards.map((card, i) => {
        const Icon = ICONS[card.kind];
        return (
          <span
            key={i}
            className="sp-mp-rail-member"
            data-treatment={treatment}
            style={{ top: `${i * (span + SEAM_PCT)}%`, height: `${span}%` }}
          >
            {treatment === "glyphs" || treatment === "faces" ? (
              <Icon className="sp-mp-icon sp-mp-icon-rail" aria-hidden="true" />
            ) : treatment === "labels" ? (
              <span className="sp-mp-label">{card.label}</span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

/** The deck, drawn small, under one treatment. */
function Mini({
  slots,
  treatment,
  showMarks = false,
  width = PLATE_WIDTH,
}: {
  slots: MockSlot[];
  treatment: Treatment;
  showMarks?: boolean;
  width?: number;
}): React.ReactElement {
  const rects = blockRects(slots.length);
  const win = rects[WINDOW.from];
  const winEnd = rects[WINDOW.to];
  return (
    <span className="sp-mp-mini" style={{ inlineSize: width }} aria-hidden="true">
      <Rail cards={LEFT_RAIL} treatment={treatment} />
      <span className="sp-mp-field">
        {slots.map((slot, i) => (
          <Block
            key={i}
            slot={slot}
            rect={rects[i]}
            treatment={treatment}
            showMark={showMarks}
          />
        ))}
        <span
          className="sp-mp-window"
          style={{
            left: `${win.left}%`,
            width: `${winEnd.left + winEnd.width - win.left}%`,
          }}
        />
      </span>
      <Rail cards={RIGHT_RAIL} treatment={treatment} />
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * The legend: numbered pills, and the toggle in its candidate homes
 * ---------------------------------------------------------------------------*/

/** The pills, at the plate's geometry, with the reader's slot filled. */
function Pills({
  count,
  width = PLATE_WIDTH,
}: {
  count: number;
  width?: number;
}): React.ReactElement {
  const rects = blockRects(count);
  const states: TugSlotState[] = Array.from({ length: count }, (_, i) =>
    i === HERE_SLOT ? "filled" : "rest",
  );
  return (
    <span className="sp-mp-strip" style={{ inlineSize: width }}>
      <span className="sp-mp-strip-rail" style={{ flexBasis: `${RAIL_PCT}%` }} />
      <span className="sp-mp-strip-field">
        <TugSlotLayout
          count={count}
          spans={rects.map((r) => ({ left: r.left / 100, width: r.width / 100 }))}
          states={states}
          size="sm"
          onSelectSlot={() => {}}
          slotLabel={(slot) => `Go to slot ${slot + 1}`}
        />
      </span>
      <span className="sp-mp-strip-rail" style={{ flexBasis: `${RAIL_PCT}%` }} />
    </span>
  );
}

function ModeGlyph({ mode }: { mode: Mode }): React.ReactElement {
  return mode === "split" ? <SplitGlyph lit={null} /> : <StackGlyph lit={null} />;
}

function describe(slot: number, mode: Mode): string {
  const now = mode === "split" ? "split" : "stacked";
  const does = mode === "split" ? "stack" : "split";
  return `Column ${slot + 1} is ${now} — click to ${does}`;
}

/** B1 — a glyph row under the pills, one toggle beneath each number. */
function GlyphRow({
  slots,
  onToggle,
  width = PLATE_WIDTH,
}: {
  slots: MockSlot[];
  onToggle: (slot: number) => void;
  width?: number;
}): React.ReactElement {
  const rects = blockRects(slots.length);
  return (
    <span className="sp-mp-strip sp-mp-glyph-row" style={{ inlineSize: width }}>
      <span className="sp-mp-strip-rail" style={{ flexBasis: `${RAIL_PCT}%` }} />
      <span className="sp-mp-strip-field">
        {slots.map((slot, i) => (
          <span
            key={i}
            className="sp-mp-glyph-cell"
            style={{ left: `${rects[i].left}%`, width: `${rects[i].width}%` }}
          >
            <TugIconButton
              icon={<ModeGlyph mode={slot.mode} />}
              aria-label={describe(i, slot.mode)}
              title={describe(i, slot.mode)}
              size="2xs"
              emphasis="ghost"
              onClick={() => onToggle(i)}
            />
          </span>
        ))}
      </span>
      <span className="sp-mp-strip-rail" style={{ flexBasis: `${RAIL_PCT}%` }} />
    </span>
  );
}

/** B2 — a two-storey pill: the number above, the glyph below, one chip.
 *  Hand-drawn rather than composed from `TugSlot`, because a chip with two
 *  pressable storeys is a shape no primitive has yet; if it wins, it becomes
 *  one. */
function TwoStoreyPills({
  slots,
  onToggle,
  width = PLATE_WIDTH,
}: {
  slots: MockSlot[];
  onToggle: (slot: number) => void;
  width?: number;
}): React.ReactElement {
  const rects = blockRects(slots.length);
  return (
    <span className="sp-mp-strip sp-mp-two-storey-row" style={{ inlineSize: width }}>
      <span className="sp-mp-strip-rail" style={{ flexBasis: `${RAIL_PCT}%` }} />
      <span className="sp-mp-strip-field">
        {slots.map((slot, i) => (
          <span
            key={i}
            className="sp-mp-glyph-cell"
            style={{ left: `${rects[i].left}%`, width: `${rects[i].width}%` }}
          >
            <span
              className="sp-mp-two-storey"
              data-here={i === HERE_SLOT ? "" : undefined}
            >
              <button
                type="button"
                className="sp-mp-storey sp-mp-storey-number"
                aria-label={`Go to slot ${i + 1}`}
              >
                {i + 1}
              </button>
              <button
                type="button"
                className="sp-mp-storey sp-mp-storey-glyph"
                aria-label={describe(i, slot.mode)}
                title={describe(i, slot.mode)}
                onClick={() => onToggle(i)}
              >
                <ModeGlyph mode={slot.mode} />
              </button>
            </span>
          </span>
        ))}
      </span>
      <span className="sp-mp-strip-rail" style={{ flexBasis: `${RAIL_PCT}%` }} />
    </span>
  );
}

/** B3 — one control, for the column the reader is in. */
function ActiveColumnToggle({ slots }: { slots: MockSlot[] }): React.ReactElement {
  return (
    <span className="sp-mp-active-toggle">
      <TugLabel size="sm" emphasis="proposal">
        Column {HERE_SLOT + 1}
      </TugLabel>
      <TugChoiceGroup
        items={[
          { value: "stack", label: "Stack" },
          { value: "split", label: "Split" },
        ]}
        value={slots[HERE_SLOT].mode}
        size="xs"
        sidePadding="xs"
      />
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * The plate: caption, drawing, legend — one proposal
 * ---------------------------------------------------------------------------*/

function useSlots(): [MockSlot[], (slot: number) => void] {
  const [slots, setSlots] = useState<MockSlot[]>(SLOTS);
  const toggle = (slot: number): void =>
    setSlots((prev) =>
      prev.map((s, i) =>
        i === slot ? { ...s, mode: s.mode === "split" ? "stack" : "split" } : s,
      ),
    );
  return [slots, toggle];
}

function Plate({
  tag,
  note,
  children,
}: {
  tag: string;
  note: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="sp-mp-proposal">
      <div className="sp-mp-tag">{tag}</div>
      <div className="sp-mp-plate">
        <div className="sp-mp-caption">
          <span className="sp-mp-caption-kind">Four Up</span>
          <span className="sp-mp-caption-sep"> · </span>
          <span>Slim</span>
        </div>
        <div className="sp-mp-plate-note">
          4 cards flow, 675 px, deck scrolls
        </div>
        {children}
      </div>
      <p className="sp-mp-note">{note}</p>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The spike
 * ---------------------------------------------------------------------------*/

const TREATMENTS: ReadonlyArray<{
  treatment: Treatment;
  tag: string;
  note: string;
}> = [
  {
    treatment: "today",
    tag: "A0 · Today",
    note: "Every card is the same bar. The picture says how the deck is arranged and nothing about what is in it; the only per-card fact is the pill's accent, one row down.",
  },
  {
    treatment: "glyphs",
    tag: "A1 · Glyphs",
    note: "Each block wears its card kind's registered icon — the same lucide name the pane's title bar draws — and a stack says its depth as a count. Cheapest to build: both facts are already in the registry and the pane list.",
  },
  {
    treatment: "faces",
    tag: "A2 · Faces",
    note: "A block becomes a tiny card: a title bar, the kind glyph, and the sheets of a stack peeking out behind the front one. A session with a turn in flight shows an activity dot in its bar. The most literal picture, and the busiest.",
  },
  {
    treatment: "tinted",
    tag: "A3 · Tints",
    note: "No marks at all — kind is said by fill. Sessions keep the card tone, file and diff cards go a step lighter, and the card the reader is in takes the Key ink the window already wears. Reads at a glance, says less.",
  },
  {
    treatment: "labels",
    tag: "A4 · Labels",
    note: "Two or three characters per card: a session's callsign initials, a file's extension. The most information per pixel, and at 210 px the pixel is the problem — it needs the full-size plate to read.",
  },
];

function SpikeMiniaturePlus(): React.ReactElement {
  const [belowSlots, toggleBelow] = useSlots();
  const [mergedSlots, toggleMerged] = useSlots();
  const [togetherSlots, toggleTogether] = useSlots();
  const [togetherLargeSlots, toggleTogetherLarge] = useSlots();

  return (
    <div className="sp-content">
      <section className="sp-section">
        <h2 className="sp-section-title">The blocks</h2>
        <p className="sp-mp-intro">
          One deck, five treatments, each at the plate's true size (210 px).
          The deck is the screenshot's: a left rail of three, four slots under
          Flow with the window over the leading pair, a right rail of two —
          slot 2 stacked three deep with the reader in it, slot 4 split. The
          stack/split marks are left off here so the treatments are judged on
          their own.
        </p>
        <div className="sp-mp-proposals">
          {TREATMENTS.map(({ treatment, tag, note }) => (
            <Plate key={treatment} tag={tag} note={note}>
              <Mini slots={SLOTS} treatment={treatment} />
              <Pills count={SLOTS.length} />
            </Plate>
          ))}
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Where the toggle lives</h2>
        <p className="sp-mp-intro">
          The same stack/split toggle in four homes, over the Glyphs treatment.
          The glyph buttons in B1 and B2 are live — press one and the slot
          above it flips.
        </p>
        <div className="sp-mp-proposals">
          <Plate
            tag="B0 · On the block (today)"
            note="The mark stands at the foot of each slot, on the drawing. It is where the place is, but it competes with anything else the block tries to say — A1 and A2 both lose their foot to it."
          >
            <Mini slots={SLOTS} treatment="glyphs" showMarks />
            <Pills count={SLOTS.length} />
          </Plate>
          <Plate
            tag="B1 · A glyph row under the pills"
            note="One toggle beneath each number, at the strip's own geometry. The drawing is freed for its content, the legend gains a second line, and the eye runs number → glyph down one vertical. Costs 20 px of height."
          >
            <Mini slots={belowSlots} treatment="glyphs" />
            <Pills count={SLOTS.length} />
            <GlyphRow slots={belowSlots} onToggle={toggleBelow} />
          </Plate>
          <Plate
            tag="B2 · A two-storey pill"
            note="Number and glyph in one chip: the top storey goes to the slot, the bottom flips its arrangement. One legend element per place rather than two rows; the chip grows taller and the accent fill has to pick a storey."
          >
            <Mini slots={mergedSlots} treatment="glyphs" />
            <TwoStoreyPills slots={mergedSlots} onToggle={toggleMerged} />
          </Plate>
          <Plate
            tag="B3 · One control, for the column you're in"
            note="The toggle leaves the picture entirely: a Stack | Split pair for the reader's own column, beside the pills. Smallest footprint, and it answers only one place — changing another column means going there first."
          >
            <Mini slots={SLOTS} treatment="glyphs" />
            <div className="sp-mp-strip-row">
              <Pills count={SLOTS.length} />
              <ActiveColumnToggle slots={SLOTS} />
            </div>
          </Plate>
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Together</h2>
        <p className="sp-mp-intro">
          The pairing I would try first: Faces for the blocks, the glyph row
          under the pills. Shown at the plate's size and a step larger, since
          the knob for that is one number.
        </p>
        <div className="sp-mp-proposals">
          <Plate
            tag="A2 + B1 · at 210 px"
            note="The picture carries kind, depth and liveness; the legend carries place and arrangement. Nothing on the drawing is a control except its parts."
          >
            <Mini slots={togetherSlots} treatment="faces" />
            <Pills count={SLOTS.length} />
            <GlyphRow slots={togetherSlots} onToggle={toggleTogether} />
          </Plate>
          <Plate
            tag="A2 + B1 · at 250 px"
            note="The same plate at scale 0.83. The faces get the room their title bars want without the drawing taking over the card."
          >
            <Mini slots={togetherLargeSlots} treatment="faces" width={250} />
            <Pills count={SLOTS.length} width={250} />
            <GlyphRow
              slots={togetherLargeSlots}
              onToggle={toggleTogetherLarge}
              width={250}
            />
          </Plate>
        </div>
      </section>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "miniature-plus",
  title: "Miniature Plus",
  blurb:
    "What a Layout block can say beyond 'a card is here', and where the stack/split toggle should live.",
  icon: "Columns3",
  size: { min: { width: 520, height: 400 }, preferred: { width: 900, height: 720 } },
  component: () => <SpikeMiniaturePlus />,
};
