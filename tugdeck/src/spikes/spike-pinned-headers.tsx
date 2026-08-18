/**
 * spike-pinned-headers.tsx — production-mirror fixture for the
 * pin-stack consolidation.
 *
 * Seven sections, each in its own fixed-height scroll wrapper (with
 * `padding: 0` so sticky descendants pin flush against the wrapper's
 * content-box top edge — `padding-block` on a sticky-hosting scroll
 * container offsets the pin reference inward):
 *
 *   1–4. Standalone `FileBlock` / `DiffBlock` / `TerminalBlock` (folded
 *        + expanded). Each block's identity header is the only pinned
 *        row; the action affordances live at the trailing edge of the
 *        same header:
 *        - FileBlock — Find + Copy + fold cue.
 *        - DiffBlock — Side-by-side/Inline `TugChoiceGroup` + fold cue.
 *        - TerminalBlock — Copy + fold cue. Section #3 is folded by
 *          default (the 400-line output exceeds `DEFAULT_COLLAPSE_THRESHOLD`)
 *          so the preview-with-fade is exercisable at first paint;
 *          section #4 forces `collapsed={false}` so the expanded path
 *          with virtualizer + footer is visible side-by-side.
 *
 *   5–7. The same body kinds composed inside `BlockChrome`
 *        (simulating `ReadToolBlock` / `EditToolBlock` /
 *        `BashToolBlock`). The body kind's own identity header is
 *        suppressed; affordances portal into the chrome's actions
 *        slot via `ChromeActionsTargetContext`. The chrome header
 *        is again the only pinned row at rest.
 *
 * What remains here is the visual smoke test: at rest, ONE pinned row
 * per block; only the Find UI (when opened on a file or diff) produces
 * a second sticky row underneath.
 *
 * @module components/tugways/cards/gallery-pinned-headers
 */

import React from "react";

import { FileBlock, type FileData } from "@/components/tugways/body-kinds/file-block";
import { DiffBlock } from "@/components/tugways/body-kinds/diff-block";
import { TerminalBlock, type TerminalData } from "@/components/tugways/body-kinds/terminal-block";
import type { DiffData } from "@/lib/diff/types";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { BlockChrome } from "@/components/tugways/blocks/block-chrome";

import "./spike.css";
import type { SpikeDef } from "./spike-registry";

// ---------------------------------------------------------------------------
// Synthesized fixtures
// ---------------------------------------------------------------------------

/**
 * Build a synthetic TypeScript-ish file with `lineCount` lines so the
 * `FileBlock` body has enough content to scroll past its wrapper's
 * fixed height. Lines vary in length so wrap behavior is visible too.
 */
function buildLongFileContent(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= lineCount; i += 1) {
    if (i % 12 === 0) {
      lines.push("");
    } else if (i % 12 === 1) {
      lines.push(`// section ${Math.floor(i / 12) + 1} — synthesized for the pinning fixture`);
    } else if (i % 5 === 0) {
      lines.push(
        `export const VALUE_${i} = { id: ${i}, label: "row-${i}", meta: { kind: "fixture", weight: ${i * 7}, payload: "${"x".repeat(40)}" } };`,
      );
    } else if (i % 3 === 0) {
      lines.push(`function compute${i}(input: number): number { return input * ${i} + ${i * 13}; }`);
    } else {
      lines.push(`const line_${i} = ${i};`);
    }
  }
  return lines.join("\n") + "\n";
}

const LONG_FILE: FileData = {
  filePath: "src/synthesized/long-fixture.ts",
  content: buildLongFileContent(280),
  totalLines: 280,
  numLines: 280,
};

/**
 * Build a unified-diff string with `hunkCount` hunks against a single
 * file. Each hunk has a few context lines plus one or two add/remove
 * pairs so word-level highlighting is exercised.
 */
function buildLongDiffText(hunkCount: number): string {
  const out: string[] = [
    "diff --git a/src/synthesized/long-fixture.ts b/src/synthesized/long-fixture.ts",
    "index 1111111..2222222 100644",
    "--- a/src/synthesized/long-fixture.ts",
    "+++ b/src/synthesized/long-fixture.ts",
  ];
  for (let h = 0; h < hunkCount; h += 1) {
    const start = h * 20 + 1;
    out.push(`@@ -${start},6 +${start},7 @@ section ${h + 1}`);
    out.push(` // context above hunk ${h + 1}`);
    out.push(` const before_${h} = ${h};`);
    out.push(`-const stale_${h} = "old value ${h}";`);
    out.push(`+const fresh_${h} = "new value ${h}!";`);
    out.push(`+const added_${h} = ${h * 11};`);
    out.push(` const after_${h} = ${h + 1};`);
    out.push(` // context below hunk ${h + 1}`);
  }
  return out.join("\n") + "\n";
}

const LONG_DIFF: DiffData = {
  source: "unified",
  text: buildLongDiffText(20),
  filePath: "src/synthesized/long-fixture.ts",
};

/**
 * Build a 400-line terminal output. Lines vary in length so the body
 * exercises horizontal per-line scroll. Sized well over the collapse
 * threshold so both the folded-by-default preview and the full flat
 * expanded body are exercised.
 */
function buildLongTerminalStdout(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= lineCount; i += 1) {
    if (i % 17 === 0) {
      lines.push(`[warn] line ${i} — a longer message that wraps past the typical column width to exercise horizontal scroll behavior inside the terminal viewport`);
    } else if (i % 7 === 0) {
      lines.push(`  → step ${i} completed in ${i * 3} ms`);
    } else {
      lines.push(`line ${i}: synthesized terminal output`);
    }
  }
  return lines.join("\n") + "\n";
}

const LONG_TERMINAL: TerminalData = {
  stdout: buildLongTerminalStdout(400),
  stderr: "",
  exitCode: 0,
  durationMs: 4_200,
};

// ---------------------------------------------------------------------------
// PinSection — a single body kind inside a fixed-height scroll wrapper
// ---------------------------------------------------------------------------

/**
 * Inline style for the scroll wrapper. The wrapper deliberately has
 * `padding: 0` so sticky descendants pin flush against the
 * padding-box top edge (per CSS Position 3 §6.5.1, `top: 0` pins
 * against the scroll container's content-box, which equals the
 * padding-box top when padding is zero). Any `padding-block` on a
 * sticky-hosting scroll container would offset the pin by that
 * amount — the root cause of the transcript-side pin offset.
 */
const SCROLLER_STYLE: React.CSSProperties = {
  height: 380,
  overflowY: "auto",
};

interface PinSectionProps {
  title: string;
  children: React.ReactNode;
}

function PinSection({ title, children }: PinSectionProps) {
  return (
    <div className="sp-section">
      <TugLabel className="sp-section-title">{title}</TugLabel>
      <div style={SCROLLER_STYLE} data-slot="pin-scroller">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SpikePinnedHeaders
// ---------------------------------------------------------------------------

export function SpikePinnedHeaders() {
  return (
    <div className="sp-content" data-testid="gallery-pinned-headers">
      <PinSection title="FileBlock — long file (header: Find, Copy, fold cue at trailing edge)">
        <FileBlock data={LONG_FILE} collapsed={false} />
      </PinSection>

      <TugSeparator />

      <PinSection title="FileBlock — long file, folded by default (preview-with-fade; click the fold cue to expand)">
        <FileBlock data={LONG_FILE} collapsed />
      </PinSection>

      <TugSeparator />

      <PinSection title="DiffBlock — 20 hunks (header: Side-by-side/Inline choice group + fold cue at trailing edge)">
        <DiffBlock data={LONG_DIFF} />
      </PinSection>

      <TugSeparator />

      <PinSection title="TerminalBlock — 400 lines, folded by default (header: Copy + fold cue at trailing edge)">
        <TerminalBlock data={LONG_TERMINAL} headerLabel={<code>find . -type f | head -400</code>} />
      </PinSection>

      <TugSeparator />

      <PinSection title="TerminalBlock — 400 lines, expanded (no fade; full output + virtualized scroller)">
        <TerminalBlock
          data={LONG_TERMINAL}
          headerLabel={<code>find . -type f | head -400</code>}
          collapsed={false}
        />
      </PinSection>

      <TugSeparator />

      <PinSection title="FileBlock inside BlockChrome — Find/Copy/fold cue portal into chrome header">
        <BlockChrome
          toolName="Read"
          argsSummary={<code>{LONG_FILE.filePath}</code>}
          status="ready"
        >
          <FileBlock data={LONG_FILE} embedded collapsed={false} />
        </BlockChrome>
      </PinSection>

      <TugSeparator />

      <PinSection title="DiffBlock inside BlockChrome — affordances portal into chrome header">
        <BlockChrome
          toolName="Edit"
          argsSummary={<code>{LONG_DIFF.filePath}</code>}
          status="ready"
        >
          <DiffBlock data={LONG_DIFF} embedded />
        </BlockChrome>
      </PinSection>

      <TugSeparator />

      <PinSection title="TerminalBlock inside BlockChrome — Copy + fold cue portal into chrome header">
        <BlockChrome
          toolName="Bash"
          argsSummary={<code>find . -type f | head -400</code>}
          status="ready"
        >
          <TerminalBlock data={LONG_TERMINAL} embedded />
        </BlockChrome>
      </PinSection>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "pinned-headers",
  title: "Pinned Headers",
  blurb: "A production mirror of the pin-stack consolidation: seven sections, each pinning inside its own scroll wrapper.",
  component: () => <SpikePinnedHeaders />,
};
