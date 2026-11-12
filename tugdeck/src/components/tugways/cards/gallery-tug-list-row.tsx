/**
 * gallery-tug-list-row.tsx — TugListRow demo tab for the Component
 * Gallery.
 *
 * Seven sections, each isolating one knob of the primitive:
 *
 *   1. Variants — `flush` vs `pill`, title-only rows side by side.
 *   2. Title + subtitle — the two-line content column.
 *   3. Leading + trailing accessories — an icon on the leading edge,
 *      a badge / chevron on the trailing edge.
 *   4. Trailing reveal — `trailingReveal="engaged"`: the accessory stays
 *      hidden until the row is engaged (hovered, focused-within,
 *      selected, or under the keyboard cursor).
 *   5. States — rest / selected / disabled.
 *   6. Selection is consumer-owned — `TugListRow` is presentational
 *      and takes no `onClick`; the demo's own wrapper owns the click
 *      and feeds `selected` back in. This is the contract a
 *      `TugListView` cell renderer fulfills.
 *   7. Children escape hatch — `children` overrides `title` /
 *      `subtitle` for non-standard content.
 *
 * @module components/tugways/cards/gallery-tug-list-row
 */

import React from "react";
import { ChevronRight, Folder, GitBranch, Trash2 } from "lucide-react";

import { TugBadge } from "@/components/tugways/tug-badge";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
  type TugListViewRowSeparator,
} from "@/components/tugways/tug-list-view";
import { TugSeparator } from "@/components/tugways/tug-separator";

// ---------------------------------------------------------------------------
// Local demo styles
// ---------------------------------------------------------------------------

const captionStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  marginBottom: "8px",
};

const resultStyle: React.CSSProperties = {
  fontSize: "0.875rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  marginTop: "8px",
};

/** Column of pill rows — the inter-row gap is the caller's, not the row's. */
const pillStackStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  width: "100%",
  maxWidth: "32.5rem",
};

/**
 * Framed panel for `flush` rows. A `flush` row is transparent and
 * draws no divider of its own — in production a `TugListView` with
 * `rowLayout="flush"` draws the 1px dividers between rows. The demo
 * panel just supplies the frame so the edge-to-edge rows read as a
 * group.
 */
const flushPanelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  maxWidth: "32.5rem",
  border: "1px solid var(--tug7-element-global-border-normal-muted-rest)",
  borderRadius: "var(--tug-radius-md)",
  overflow: "hidden",
};

const labelColumnStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.375rem",
};

/** Bounded-height frame for a separator-demo `TugListView`. */
const separatorHostStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: "15rem",
  height: "9.5rem",
  border: "1px solid var(--tug7-element-global-border-normal-muted-rest)",
  borderRadius: "var(--tug-radius-md)",
  overflow: "hidden",
};

const variantsRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "1.5rem",
  flexWrap: "wrap",
};

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

const RECENTS: ReadonlyArray<string> = [
  "/u/src/tugtool",
  "/tmp/test-project",
  "/u/src/tugtool/tugdeck",
];

// ---------------------------------------------------------------------------
// Separator demo — a tiny static `TugListView` so the real divider CSS
// (which targets `.tug-list-view ... .tug-list-view-cell`) is exercised
// rather than faked. Read-only, four flush rows per list.
// ---------------------------------------------------------------------------

const SEPARATOR_ROWS: ReadonlyArray<string> = [
  "First row",
  "Second row",
  "Third row",
  "Fourth row",
];

/** Minimal read-only data source over `SEPARATOR_ROWS`. */
class SeparatorDemoDataSource implements TugListViewDataSource {
  numberOfItems(): number {
    return SEPARATOR_ROWS.length;
  }
  idForIndex(index: number): string {
    return `sep-${index}`;
  }
  kindForIndex(): string {
    return "row";
  }
  titleAt(index: number): string {
    return SEPARATOR_ROWS[index];
  }
  subscribe(): () => void {
    return () => {};
  }
  getVersion(): unknown {
    return 0;
  }
}

const SeparatorDemoCell: TugListViewCellRenderer<SeparatorDemoDataSource> =
  function SeparatorDemoCell({
    index,
    dataSource,
  }: TugListViewCellProps<SeparatorDemoDataSource>): React.ReactElement {
    return <TugListRow title={dataSource.titleAt(index)} />;
  };

const SEPARATOR_CELL_RENDERERS: Record<
  string,
  TugListViewCellRenderer<SeparatorDemoDataSource>
> = { row: SeparatorDemoCell };

/** One bounded-height list demoing a single `rowSeparator` value. */
function SeparatorDemoList({
  label,
  rowSeparator,
  dataSource,
}: {
  label: string;
  rowSeparator?: TugListViewRowSeparator;
  dataSource: SeparatorDemoDataSource;
}): React.ReactElement {
  return (
    <div style={labelColumnStyle}>
      <TugLabel className="cg-section-title">{label}</TugLabel>
      <div style={separatorHostStyle}>
        <TugListView<SeparatorDemoDataSource>
          dataSource={dataSource}
          cellRenderers={SEPARATOR_CELL_RENDERERS}
          rowLayout="flush"
          rowSeparator={rowSeparator}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GalleryTugListRow
// ---------------------------------------------------------------------------

export function GalleryTugListRow(): React.ReactElement {
  // Section 6 — consumer-owned selection. The wrapper owns the click;
  // `TugListRow` only renders `selected`.
  const [selectedRecent, setSelectedRecent] = React.useState<string>(
    RECENTS[0],
  );

  // Section 4 — a result line so the hover-revealed icon button is
  // demonstrably live, not just decorative.
  const [revealResult, setRevealResult] = React.useState<string>("—");

  // Separator demo — one read-only data source shared across the four
  // demo lists (they only read it). Stable for the card's lifetime.
  const separatorDataSourceRef = React.useRef<SeparatorDemoDataSource | null>(
    null,
  );
  if (separatorDataSourceRef.current === null) {
    separatorDataSourceRef.current = new SeparatorDemoDataSource();
  }
  const separatorDataSource = separatorDataSourceRef.current;

  return (
    <div className="cg-content" data-testid="gallery-tug-list-row">
      {/* ---- 1. Variants ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Variants</TugLabel>
        <div style={captionStyle}>
          <code>flush</code> is edge-to-edge and transparent (dividers
          come from the enclosing <code>TugListView</code>);{" "}
          <code>pill</code> is a discrete bordered, rounded row.
        </div>
        <div style={variantsRowStyle}>
          <div style={labelColumnStyle}>
            <TugLabel className="cg-section-title">flush</TugLabel>
            <div style={flushPanelStyle}>
              <TugListRow variant="flush" title="Rest row" />
              <TugListRow variant="flush" title="Selected row" selected />
              <TugListRow variant="flush" title="Another row" />
            </div>
          </div>
          <div style={labelColumnStyle}>
            <TugLabel className="cg-section-title">pill</TugLabel>
            <div style={pillStackStyle}>
              <TugListRow variant="pill" title="Rest row" />
              <TugListRow variant="pill" title="Selected row" selected />
              <TugListRow variant="pill" title="Another row" />
            </div>
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 2. Title + subtitle ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Title + subtitle</TugLabel>
        <div style={captionStyle}>
          The two-line content column — a <code>title</code> over a
          muted <code>subtitle</code>.
        </div>
        <div style={pillStackStyle}>
          <TugListRow
            variant="pill"
            title="Add retry logic to the API client"
            description="Last opened 2 hours ago"
          />
          <TugListRow
            variant="pill"
            title="Repair the capture pipeline"
            description="Last opened yesterday"
          />
        </div>
      </div>

      <TugSeparator />

      {/* ---- 2b. Standard row types ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Row types</TugLabel>
        <div style={captionStyle}>
          The common layouts fall out of <code>title</code> +{" "}
          <code>subtitle</code> + <code>subtitleMaxLines</code>, composed
          with a leading icon and the <code>selectedGlyph</code> check
          column. Single-line, two-line, and a multiline description that
          wraps instead of truncating.
        </div>
        <div style={flushPanelStyle}>
          <TugListRow title="Single line" />
          <TugListRow
            leading={<Folder size={16} aria-hidden="true" />}
            title="Single line with a leading icon"
          />
          <TugListRow
            selectedGlyph="check"
            selected
            title="Checked single line"
          />
          <TugListRow
            selectedGlyph="check"
            title="Unchecked — column reserved, title aligns"
          />
          <TugListRow
            leading={<GitBranch size={16} aria-hidden="true" />}
            title="Two line with icon"
            description="A muted secondary line below the title"
          />
          <TugListRow
            title="Multiline description"
            description="A longer subtitle that wraps across multiple lines instead of truncating, for rows that carry a real description rather than a one-line caption — useful for skills, agents, and other catalog rows."
            descriptionMaxLines={3}
          />
        </div>
      </div>

      <TugSeparator />

      {/* ---- 3. Leading + trailing accessories ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">
          Leading + trailing accessories
        </TugLabel>
        <div style={captionStyle}>
          <code>leading</code> and <code>trailing</code> take arbitrary
          nodes — a glyph, a badge, a chevron, a control.
        </div>
        <div style={pillStackStyle}>
          <TugListRow
            variant="pill"
            leading={<Folder size={16} aria-hidden="true" />}
            title="/u/src/tugtool"
            trailing={<ChevronRight size={16} aria-hidden="true" />}
          />
          <TugListRow
            variant="pill"
            leading={<GitBranch size={16} aria-hidden="true" />}
            title="feature/list-row"
            description="3 commits ahead"
            trailing={
              <TugBadge size="sm" emphasis="tinted" role="action">
                live
              </TugBadge>
            }
          />
        </div>
      </div>

      <TugSeparator />

      {/* ---- 4. Trailing reveal ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">
          Trailing reveal — engaged
        </TugLabel>
        <div style={captionStyle}>
          <code>trailingReveal="engaged"</code> keeps the trailing
          accessory hidden until the row is engaged — hovered, holding
          focus, selected, or under the keyboard cursor — so the closed
          row reads clean. Hover a row to surface its delete button.
        </div>
        <div style={pillStackStyle}>
          {RECENTS.map((path) => (
            <TugListRow
              key={path}
              variant="pill"
              title={path}
              trailingReveal="engaged"
              trailing={
                <TugIconButton size="sm"
                  icon={<Trash2 size={14} aria-hidden="true" />}
                  aria-label={`Trash ${path}`}
                  title={`Trash ${path}`}
                  role="danger"
                  onClick={() => setRevealResult(`Trash ${path}`)}
                />
              }
            />
          ))}
        </div>
        <div style={resultStyle}>
          Last action: <strong>{revealResult}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 4b. Trailing reveal — claim ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">
          Trailing reveal — claim
        </TugLabel>
        <div style={captionStyle}>
          <code>trailingReveal="claim"</code> reserves no width at rest:
          the title runs the full row and the accessory takes its space
          back on engage, truncating the title only while it shows. The
          mode for dense one-line rows where standing gutter space would
          cost more than the truncation does.
        </div>
        <div style={pillStackStyle}>
          {RECENTS.map((path) => (
            <TugListRow
              key={path}
              variant="pill"
              title={`${path} — a long enough title to reach the trailing edge`}
              trailingReveal="claim"
              trailing={
                <TugIconButton size="sm"
                  icon={<Trash2 size={14} aria-hidden="true" />}
                  aria-label={`Trash ${path}`}
                  title={`Trash ${path}`}
                  role="danger"
                  onClick={() => setRevealResult(`Trash ${path}`)}
                />
              }
            />
          ))}
        </div>
      </div>

      <TugSeparator />

      {/* ---- 5. States — the selection ramp, plus the press ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">States</TugLabel>
        <div style={captionStyle}>
          The list owns its own selection family (the blue selection
          tokens), distinct from the popup-button menus. The ramp is{" "}
          <strong>rest → hover → pressed → selected → selected +
          hover</strong>. <em>Hover the rows below</em> — a hovered
          selected row paints a stronger fill than a resting selected
          row, and differs from a hovered unselected row.{" "}
          <em>Now hold the mouse down on one</em> — the press wears the
          selection&apos;s own hue, a preview of what the click commits, so
          a row whose click acts without selecting still answers the
          finger. A press on an already-selected row steps one ramp
          further. It arrives on the frame the button goes down and fades
          out on release: the press is a layer of its own, so its clock is
          nothing to do with the hover fill underneath it.{" "}
          <code>selected</code> and <code>disabled</code> are
          inputs the consumer feeds — the row reflects them, it does not
          own them.
        </div>
        <div style={variantsRowStyle}>
          <div style={labelColumnStyle}>
            <TugLabel className="cg-section-title">flush</TugLabel>
            <div style={flushPanelStyle}>
              <TugListRow variant="flush" title="Rest" description="Hover me" />
              <TugListRow
                variant="flush"
                title="Selected"
                description="Hover me — stronger fill"
                selected
              />
              <TugListRow
                variant="flush"
                title="Disabled"
                description="Fed disabled={true}"
                disabled
              />
            </div>
          </div>
          <div style={labelColumnStyle}>
            <TugLabel className="cg-section-title">pill</TugLabel>
            <div style={pillStackStyle}>
              <TugListRow variant="pill" title="Rest" description="Hover me" />
              <TugListRow
                variant="pill"
                title="Selected"
                description="Hover me — stronger fill"
                selected
              />
              <TugListRow
                variant="pill"
                title="Disabled"
                description="Fed disabled={true}"
                disabled
              />
            </div>
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 5b. Accent selection border ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">
          Accent selection border
        </TugLabel>
        <div style={captionStyle}>
          <code>selectedAccent</code> draws an accent-colored border on
          the selected row. <code>flush</code> paints an inset shadow (no
          row-height change, so moving the selection never reflows);{" "}
          <code>pill</code> swaps its border color.
        </div>
        <div style={variantsRowStyle}>
          <div style={labelColumnStyle}>
            <TugLabel className="cg-section-title">flush</TugLabel>
            <div style={flushPanelStyle}>
              <TugListRow variant="flush" title="Rest row" />
              <TugListRow
                variant="flush"
                title="Selected + accent"
                selected
                selectedAccent
              />
              <TugListRow variant="flush" title="Another row" />
            </div>
          </div>
          <div style={labelColumnStyle}>
            <TugLabel className="cg-section-title">pill</TugLabel>
            <div style={pillStackStyle}>
              <TugListRow variant="pill" title="Rest row" />
              <TugListRow
                variant="pill"
                title="Selected + accent"
                selected
                selectedAccent
              />
              <TugListRow variant="pill" title="Another row" />
            </div>
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 5c. Row separators (a TugListView prop) ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Row separators</TugLabel>
        <div style={captionStyle}>
          <code>rowSeparator</code> on <code>TugListView</code> tunes the
          divider drawn between cells: <code>hairline</code> (1px, the
          default), <code>thin</code> (1.5px), <code>medium</code> (2px),
          or <code>"none"</code>. A <code>color</code> override is also
          accepted. These are real <code>TugListView</code> instances so
          the divider CSS is exercised, not faked.
        </div>
        <div style={variantsRowStyle}>
          <SeparatorDemoList
            label="hairline (default)"
            dataSource={separatorDataSource}
          />
          <SeparatorDemoList
            label="thin"
            rowSeparator={{ thickness: "thin" }}
            dataSource={separatorDataSource}
          />
          <SeparatorDemoList
            label="medium"
            rowSeparator={{ thickness: "medium" }}
            dataSource={separatorDataSource}
          />
          <SeparatorDemoList
            label="none"
            rowSeparator="none"
            dataSource={separatorDataSource}
          />
        </div>
      </div>

      <TugSeparator />

      {/* ---- 6. Consumer-owned selection ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">
          Selection is consumer-owned
        </TugLabel>
        <div style={captionStyle}>
          <code>TugListRow</code> is presentational — it takes no{" "}
          <code>onClick</code>. The wrapper below owns the click and
          feeds <code>selected</code> back in. This is the contract a{" "}
          <code>TugListView</code> cell renderer fulfills.
        </div>
        <div style={pillStackStyle}>
          {RECENTS.map((path) => (
            <div
              key={path}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedRecent(path)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelectedRecent(path);
                }
              }}
              style={{ cursor: "pointer" }}
            >
              <TugListRow
                variant="pill"
                title={path}
                selected={path === selectedRecent}
              />
            </div>
          ))}
        </div>
        <div style={resultStyle}>
          Selected: <strong>{selectedRecent}</strong>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 7. Children escape hatch ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Children escape hatch</TugLabel>
        <div style={captionStyle}>
          When <code>children</code> is provided it owns the content
          column outright and <code>title</code> / <code>subtitle</code>{" "}
          are ignored — for rows whose content is not a plain
          title / subtitle stack.
        </div>
        <div style={pillStackStyle}>
          <TugListRow variant="pill">
            <span style={{ fontFamily: "var(--tug-font-family-mono)" }}>
              /u/src/tugtool/tugdeck/src
            </span>
          </TugListRow>
        </div>
      </div>
    </div>
  );
}
