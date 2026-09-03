/**
 * spike-place-coordinate.tsx — one coordinate, one popup: can the masthead's
 * place badges join their cluster's family, and can the Lens's exhaustive
 * slot run window to three chips without losing the glance?
 *
 * Everything on display is the shipping vocabulary — real `TugSlot`,
 * `TugSlotLayout`, `TugColumnBadge`, real cluster classes from `tug-pane.css`
 * and `card-slot-badge.css` — so "now" is drawn by the same rules the deck
 * draws it with, and "proposed" differs only where the proposal differs. The
 * fixtures are live: hover the clusters, press the chips, open the doors.
 *
 * Three questions, one per section:
 *
 *  1. The masthead badge sized down (chip 16×20, font kept at 11px) and made
 *     a ghost `TugButton` like every neighbour, so it answers the pointer
 *     with the cluster's own hover box instead of `TugSlot`'s accent outline.
 *  2. The Lens run windowed to three chips, the held slot always centre —
 *     a neighbour press nudges one over, the centre press opens the full run.
 *  3. The Lens column badge as a door: the same place popup the masthead
 *     already has (members, split/stack/equalize), plus in-column reorder.
 */

import "./spike.css";
import "./spike-place-coordinate.css";

import React, { useState } from "react";
import {
  CircleDot,
  FileText,
  GitCompareArrows,
  MessageSquare,
  MoveHorizontal,
  X,
  type LucideIcon,
} from "lucide-react";

import { TugButton } from "@/components/tugways/internal/tug-button";
import { TugPopupMenu } from "@/components/tugways/internal/tug-popup-menu";
import type { TugPopupMenuItem } from "@/components/tugways/internal/tug-popup-menu";
import { TugSlot } from "@/components/tugways/tug-slot";
import type { TugSlotState } from "@/components/tugways/tug-slot";
import { TugSlotLayout } from "@/components/tugways/tug-slot-layout";
import {
  TugColumnBadge,
  columnBadgeCharacter,
} from "@/components/tugways/tug-column-badge";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import {
  TugPopover,
  TugPopoverContent,
  TugPopoverTrigger,
} from "@/components/tugways/tug-popover";

import type { SpikeDef } from "./spike-registry";

// ---------------------------------------------------------------------------
// Fixture state — a place, described the way the deck describes one
// ---------------------------------------------------------------------------

interface PlaceMember {
  title: string;
  icon: LucideIcon;
}

interface PlaceFacts {
  /** 0-based slot the card holds. */
  held: number;
  /** How the place is arranged. */
  kind: "stack" | "split";
  /** This card's 0-based position within the place, front/top first. */
  index: number;
  /** Everyone in the place, in order. */
  members: PlaceMember[];
}

const SESSION_MEMBERS: PlaceMember[] = [
  { title: "tugtool/juicy-roach", icon: MessageSquare },
  { title: "arc-notes.md", icon: FileText },
];

const DIFF_MEMBERS: PlaceMember[] = [
  { title: "layout-imposer-xp:tugtool/nimble-gnat", icon: MessageSquare },
  { title: "Project Diff", icon: GitCompareArrows },
  { title: "durable-commits", icon: MessageSquare },
];

/** The slot run's states for a card holding `held` at the front of its place. */
function runStates(count: number, facts: PlaceFacts): TugSlotState[] {
  return Array.from({ length: count }, (_, slot) => {
    if (slot !== facts.held) return "rest";
    return facts.index === 0 ? "filled" : "outlined";
  });
}

// ---------------------------------------------------------------------------
// The place popup — the masthead stack badge's menu, plus in-column reorder
// ---------------------------------------------------------------------------

const PLACE_VERB_SPLIT = "verb-split";
const PLACE_VERB_STACK = "verb-stack";
const PLACE_VERB_EQUALIZE = "verb-equalize";
const PLACE_VERB_UP = "verb-up";
const PLACE_VERB_DOWN = "verb-down";

/** The menu the door opens: members first, then the place's verbs — exactly
 *  the masthead stack menu's shape, with Move Up / Move Down added, which is
 *  the proposal's one new pair. */
function placeMenuItems(facts: PlaceFacts): TugPopupMenuItem[] {
  const alone = facts.members.length <= 1;
  const memberRows: TugPopupMenuItem[] = facts.members.map((member, i) => {
    const MemberIcon = member.icon;
    return {
      id: `member-${i}`,
      label: member.title,
      icon: <MemberIcon />,
      selected: i === facts.index,
    };
  });
  const arrangeVerbs: TugPopupMenuItem[] =
    facts.kind === "split"
      ? [
          { id: PLACE_VERB_STACK, label: "Stack" },
          ...(alone
            ? []
            : [{ id: PLACE_VERB_EQUALIZE, label: "Equalize Heights" }]),
        ]
      : [{ id: PLACE_VERB_SPLIT, label: "Split Vertically" }];
  const moveVerbs: TugPopupMenuItem[] = alone
    ? []
    : [
        {
          id: PLACE_VERB_UP,
          label: facts.kind === "split" ? "Move Up" : "Bring Forward",
          disabled: facts.index === 0,
        },
        {
          id: PLACE_VERB_DOWN,
          label: facts.kind === "split" ? "Move Down" : "Send Back",
          disabled: facts.index >= facts.members.length - 1,
        },
      ];
  return [...memberRows, ...arrangeVerbs, ...moveVerbs];
}

function applyPlaceMenu(facts: PlaceFacts, id: string): PlaceFacts {
  if (id === PLACE_VERB_SPLIT) return { ...facts, kind: "split" };
  if (id === PLACE_VERB_STACK) return { ...facts, kind: "stack" };
  if (id === PLACE_VERB_EQUALIZE) return facts;
  if (id === PLACE_VERB_UP)
    return { ...facts, index: Math.max(0, facts.index - 1) };
  if (id === PLACE_VERB_DOWN)
    return {
      ...facts,
      index: Math.min(facts.members.length - 1, facts.index + 1),
    };
  const member = /^member-(\d+)$/.exec(id);
  if (member !== null) return { ...facts, index: Number(member[1]) };
  return facts;
}

function doorTip(facts: PlaceFacts): string {
  const n = facts.members.length;
  if (facts.kind === "split")
    return `Band ${columnBadgeCharacter("split", n, facts.index)} of ${n} — press to arrange this split`;
  if (n <= 1) return "Alone here — press to split";
  return `${n} cards stacked here — press to arrange the stack`;
}

// ---------------------------------------------------------------------------
// The full-run popup — the jump-anywhere surface both badges open
// ---------------------------------------------------------------------------

function SlotRunPopover({
  count,
  held,
  onPick,
  open,
  onOpenChange,
  children,
}: {
  count: number;
  held: number;
  onPick: (slot: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactElement;
}): React.ReactElement {
  return (
    <TugPopover open={open} onOpenChange={onOpenChange}>
      <TugPopoverTrigger>{children}</TugPopoverTrigger>
      <TugPopoverContent side="bottom" align="center">
        <TugSlotLayout
          className="tug-slot-layout-popup"
          count={count}
          states={Array.from({ length: count }, (_, slot) =>
            slot === held ? "filled" : "rest",
          )}
          slotLabel={(slot) => `Put at position ${slot + 1}`}
          onSelectSlot={(slot) => {
            onPick(slot);
            onOpenChange(false);
          }}
        />
      </TugPopoverContent>
    </TugPopover>
  );
}

// ---------------------------------------------------------------------------
// Section 1 — the masthead cluster
// ---------------------------------------------------------------------------

function ClusterIcon({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}): React.ReactElement {
  return (
    <TugButton
      subtype="icon"
      emphasis="ghost"
      role="action"
      size="sm"
      icon={icon}
      aria-label={label}
      onClick={() => {}}
    />
  );
}

function MastheadFixture({
  variant,
  focused,
}: {
  variant: "now" | "proposed";
  focused: boolean;
}): React.ReactElement {
  const count = 6;
  const [held, setHeld] = useState(1);
  const [slotOpen, setSlotOpen] = useState(false);
  const [facts, setFacts] = useState<PlaceFacts>({
    held: 1,
    kind: "stack",
    index: 0,
    members: SESSION_MEMBERS,
  });

  const tip = `In position ${held + 1} of ${count} — press to move this card`;

  const slotBadge =
    variant === "now" ? (
      // The shipping composition, class for class: `card-slot-badge` outermost,
      // the tooltip anchoring a span, the trigger claiming the chip. The chip
      // is a `TugSlot` CONTROL, which is what excludes it from the cluster's
      // ghost rules (`:not(.tug-slot)`) and gives it the accent-outline hover.
      <span className="card-slot-badge">
        <SlotRunPopover
          count={count}
          held={held}
          onPick={setHeld}
          open={slotOpen}
          onOpenChange={setSlotOpen}
        >
          <TugTooltip content={tip}>
            <span className="card-slot-badge-anchor">
              <TugSlot
                number={held + 1}
                state="rest"
                size="sm"
                aria-label={tip}
                onSelect={() => setSlotOpen(true)}
              />
            </span>
          </TugTooltip>
        </SlotRunPopover>
      </span>
    ) : (
      // The proposal: the winged chip becomes the ICON of a ghost button, so
      // the cluster's own state rules paint it — rest, hover box, pressed,
      // focused/background pane — with the chip's ink riding `currentColor`.
      // The chip inside is the inert exemplar form; the button is the control.
      <SlotRunPopover
        count={count}
        held={held}
        onPick={setHeld}
        open={slotOpen}
        onOpenChange={setSlotOpen}
      >
        <TugTooltip content={tip}>
          <span className="tug-pane-title-bar-tooltip-anchor">
            <TugButton
              subtype="icon"
              emphasis="ghost"
              role="action"
              size="sm"
              className="sp-pc-slot-button"
              icon={
                <span className="card-slot-badge">
                  <TugSlot number={held + 1} state="rest" size="sm" />
                </span>
              }
              aria-label={tip}
              onClick={() => setSlotOpen(true)}
            />
          </span>
        </TugTooltip>
      </SlotRunPopover>
    );

  return (
    <div
      className="tug-pane sp-pc-pane"
      data-focused={focused ? "true" : undefined}
      data-variant={variant}
    >
      <div className="tug-pane-title-bar sp-pc-bar">
        <span className="tug-pane-icon">
          <MessageSquare />
        </span>
        <span className="tug-pane-title">tugtool/juicy-roach</span>
        <div className="tug-pane-title-bar-controls">
          <ClusterIcon icon={<MoveHorizontal />} label="Card width" />
          <ClusterIcon icon={<CircleDot />} label="Bullseye" />
          {slotBadge}
          <TugTooltip content={doorTip(facts)}>
            <span className="tug-pane-title-bar-tooltip-anchor">
              <TugPopupMenu
                trigger={
                  <TugButton
                    subtype="icon"
                    emphasis="ghost"
                    role="action"
                    size="sm"
                    className="tug-pane-title-bar-stack-badge"
                    icon={
                      <TugColumnBadge
                        kind={facts.kind}
                        count={facts.members.length}
                        index={facts.index}
                        showLevel={false}
                      />
                    }
                    aria-label={doorTip(facts)}
                  />
                }
                align="end"
                items={placeMenuItems(facts)}
                onSelect={(id) => setFacts((f) => applyPlaceMenu(f, id))}
              />
            </span>
          </TugTooltip>
          <ClusterIcon icon={<X />} label="Close" />
        </div>
      </div>
      <div className="sp-pc-body">Prepare to continue improving the layout…</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections 2 & 3 — the Lens rows
// ---------------------------------------------------------------------------

interface LensRowFixture {
  title: string;
  icon: LucideIcon;
  facts: PlaceFacts;
}

const LENS_ROWS: LensRowFixture[] = [
  {
    title: "tugtool/juicy-roach",
    icon: MessageSquare,
    facts: { held: 1, kind: "stack", index: 0, members: SESSION_MEMBERS },
  },
  {
    title: "layout-imposer-xp:tugtool/nimble-gnat",
    icon: MessageSquare,
    facts: { held: 0, kind: "split", index: 0, members: DIFF_MEMBERS },
  },
  {
    title: "durable-commits",
    icon: MessageSquare,
    facts: { held: 1, kind: "stack", index: 1, members: DIFF_MEMBERS },
  },
  {
    title: "arc-notes.md",
    icon: FileText,
    facts: {
      held: 2,
      kind: "stack",
      index: 0,
      members: [{ title: "arc-notes.md", icon: FileText }],
    },
  },
];

/** A Lens list row's frame: icon, title, then whatever the variant puts in the
 *  slots position. The frame is fixture; the slots content is the subject. */
function LensRow({
  title,
  icon: RowIcon,
  children,
}: {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="sp-pc-row">
      <RowIcon className="sp-pc-row-icon" aria-hidden="true" />
      <span className="sp-pc-row-title">{title}</span>
      {children}
    </div>
  );
}

/** Today's row: the exhaustive run at the `slot-picker` cut, then the badge
 *  as a readout — the shipping classes, so this IS the current drawing. */
function LensRowNow({ row }: { row: LensRowFixture }): React.ReactElement {
  const [facts, setFacts] = useState<PlaceFacts>(row.facts);
  return (
    <LensRow title={row.title} icon={row.icon}>
      <TugSlotLayout
        className="slot-picker"
        count={6}
        states={runStates(6, facts)}
        slotLabel={(slot) => `Put at position ${slot + 1}`}
        onSelectSlot={(slot) => setFacts((f) => ({ ...f, held: slot }))}
      />
      <TugColumnBadge
        className="lens-column-badge"
        kind={facts.kind}
        count={facts.members.length}
        index={facts.index}
      />
    </LensRow>
  );
}

/** The proposed row: a three-chip window with the held slot always centre,
 *  and the column badge grown into a door. */
function LensRowProposed({
  row,
  count,
}: {
  row: LensRowFixture;
  count: number;
}): React.ReactElement {
  const [facts, setFacts] = useState<PlaceFacts>(row.facts);
  const [jumpOpen, setJumpOpen] = useState(false);

  const setHeld = (slot: number): void =>
    setFacts((f) => ({ ...f, held: slot }));

  const centreState: TugSlotState = facts.index === 0 ? "filled" : "outlined";
  const centreTip = `In position ${facts.held + 1} of ${count} — press to jump anywhere`;

  const neighbour = (slot: number, key: string): React.ReactNode => {
    if (slot < 0 || slot >= count)
      return <span key={key} className="sp-pc-stub" aria-hidden="true" />;
    const tip = `Move to position ${slot + 1}`;
    return (
      <TugTooltip key={key} content={tip}>
        <span className="sp-pc-chip-anchor">
          <TugSlot
            number={slot + 1}
            state="rest"
            size="sm"
            aria-label={tip}
            onSelect={() => setHeld(slot)}
          />
        </span>
      </TugTooltip>
    );
  };

  return (
    <LensRow title={row.title} icon={row.icon}>
      <span className="sp-pc-window">
        {neighbour(facts.held - 1, "left")}
        <SlotRunPopover
          count={count}
          held={facts.held}
          onPick={setHeld}
          open={jumpOpen}
          onOpenChange={setJumpOpen}
        >
          <TugTooltip content={centreTip}>
            <span className="sp-pc-chip-anchor">
              <TugSlot
                number={facts.held + 1}
                state={centreState}
                size="sm"
                aria-label={centreTip}
                onSelect={() => setJumpOpen(true)}
              />
            </span>
          </TugTooltip>
        </SlotRunPopover>
        {neighbour(facts.held + 1, "right")}
      </span>
      <TugTooltip content={doorTip(facts)}>
        <span className="sp-pc-chip-anchor">
          <TugPopupMenu
            trigger={
              <TugButton
                subtype="icon"
                emphasis="ghost"
                role="action"
                size="sm"
                className="sp-pc-place-door"
                icon={
                  <TugColumnBadge
                    className="lens-column-badge"
                    kind={facts.kind}
                    count={facts.members.length}
                    index={facts.index}
                  />
                }
                aria-label={doorTip(facts)}
              />
            }
            align="end"
            items={placeMenuItems(facts)}
            onSelect={(id) => setFacts((f) => applyPlaceMenu(f, id))}
          />
        </span>
      </TugTooltip>
    </LensRow>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function SpikePlaceCoordinate(): React.ReactElement {
  return (
    <div className="sp-content">
      <section className="sp-section">
        <h2 className="sp-section-title">The masthead cluster</h2>
        <p className="sp-pc-note">
          The slot chip drops from 18×22 to 16×20 with its 11px numeral kept,
          and becomes a ghost button like every neighbour — hover each cluster:
          the current chip answers with an accent outline of its own while the
          proposed one takes the same hover box as the buttons beside it. The
          column badge slims to match, so the pair still reads as one
          coordinate. Both badges stay doors: chip opens the slot run, glyph
          opens the place menu.
        </p>
        <div className="sp-pc-grid">
          <div>
            <div className="sp-pc-tag">Now</div>
            <MastheadFixture variant="now" focused />
          </div>
          <div>
            <div className="sp-pc-tag">Proposed</div>
            <MastheadFixture variant="proposed" focused />
          </div>
          <div className="sp-pc-pair">
            <div>
              <div className="sp-pc-tag">Now · background pane</div>
              <MastheadFixture variant="now" focused={false} />
            </div>
            <div>
              <div className="sp-pc-tag">Proposed · background pane</div>
              <MastheadFixture variant="proposed" focused={false} />
            </div>
          </div>
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">The Lens run, windowed</h2>
        <p className="sp-pc-note">
          Six chips per row become three: the held slot always in the centre,
          one neighbour each side, a quiet stub where the run ends. The answer
          sits at the same x on every row, so the column reads at a glance —
          and the row's cost no longer grows with the slot count. A neighbour
          press nudges one over; the centre press opens the full run to jump
          anywhere — the same popup the masthead chip opens.
        </p>
        <div className="sp-pc-grid">
          <div>
            <div className="sp-pc-tag">Now · six-up</div>
            <div className="sp-pc-lens">
              {LENS_ROWS.map((row) => (
                <LensRowNow key={row.title} row={row} />
              ))}
            </div>
          </div>
          <div>
            <div className="sp-pc-tag">Proposed · six-up</div>
            <div className="sp-pc-lens">
              {LENS_ROWS.map((row) => (
                <LensRowProposed key={row.title} row={row} count={6} />
              ))}
            </div>
          </div>
          <div>
            <div className="sp-pc-tag">
              Proposed · ten-up — the corner, reopened
            </div>
            <div className="sp-pc-lens">
              <LensRowProposed
                row={{
                  title: "durable-commits",
                  icon: MessageSquare,
                  facts: {
                    held: 6,
                    kind: "stack",
                    index: 0,
                    members: DIFF_MEMBERS,
                  },
                }}
                count={10}
              />
              <LensRowProposed
                row={{
                  title: "arc-notes.md",
                  icon: FileText,
                  facts: {
                    held: 0,
                    kind: "stack",
                    index: 0,
                    members: [{ title: "arc-notes.md", icon: FileText }],
                  },
                }}
                count={10}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">The column badge becomes a door</h2>
        <p className="sp-pc-note">
          In the proposed rows above, press the stack/split glyph: the same
          place menu the masthead's badge opens — the place's members with the
          current one checked, Split Vertically / Stack / Equalize Heights —
          plus the one pair that exists nowhere in the Lens today: reorder
          within the place (Move Up / Move Down on a split, Bring Forward /
          Send Back on a stack). The menu is live here: re-band a split and
          the letter changes, re-stack it and the letter becomes a count.
        </p>
      </section>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "place-coordinate",
  title: "Place Coordinate",
  blurb:
    "One coordinate, one popup — the masthead badges join their family, the Lens run windows to three.",
  icon: "LayoutGrid",
  component: () => <SpikePlaceCoordinate />,
};
