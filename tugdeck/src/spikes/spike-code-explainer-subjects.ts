/**
 * spike-code-explainer-subjects.ts — what the spike draws.
 *
 * One benchmark and three subjects from this repository. The benchmark is
 * the figure the idea came from, restated as a spec, so the question "can a
 * form reach that figure from names and order alone" has a direct answer.
 * The three subjects are real parts of Tug, one per form.
 *
 * @module spikes/spike-code-explainer-subjects
 */

import type { DiagramSpec } from "./spike-code-explainer-layout";

export interface Subject {
  id: string;
  /** States the finding, as a chart title does. */
  title: string;
  /** One sentence reading the figure's colours and marks. */
  caption: string;
  /** The short paragraph under the caption. */
  lead: string;
  spec: DiagramSpec;
}

export const SUBJECTS: readonly Subject[] = [
  {
    id: "benchmark",
    title: "Benchmark: how nai-memory keeps users apart today",
    caption:
      "Green: user A reads their own graph. Red: user B asks for user A's graph, and the scope check refuses the request inside nai-memory, so FalkorDB never runs the query.",
    lead: "The figure the idea came from, restated as a flow spec: three columns, two boxes with rows, four edges. No coordinate is given.",
    spec: {
      form: "flow",
      columns: [
        [
          { id: "a", name: "User A", sub: "asks for own memory" },
          { id: "b", name: "User B", sub: "asks for A's memory" },
        ],
        [
          {
            id: "api",
            name: "nai-memory API and MCP",
            sub: "every request passes three checks",
            rows: [
              { key: 1, name: "Sign-in", sub: "who is calling, and their tier" },
              { key: 2, name: "Scope check", sub: "does the caller own this scope?" },
              { key: 3, name: "Label ceiling", sub: "may this label leave the department?" },
            ],
          },
        ],
        [
          {
            id: "db",
            name: "FalkorDB (one server)",
            sub: "one graph per scope",
            rows: [
              { name: "personal:user-a", mono: true, lit: "good" },
              { name: "personal:user-b", mono: true },
              { name: "team:payments", mono: true },
              { name: "_meta-governance", mono: true },
            ],
            notes: ["only memory pods may connect · one password", "TLS on AWS · KMS-encrypted disk"],
          },
        ],
      ],
      edges: [
        { from: "a", to: "api", tone: "good" },
        { from: "b", to: "api", tone: "bad" },
        { from: "api.1", to: "db.1", tone: "good", label: "allowed" },
        { from: "api.2", to: "b", tone: "bad", dashed: true, label: "refused with HTTP 403 before FalkorDB is touched" },
      ],
    },
  },
  {
    id: "edit-gate",
    title: "A shell edit the gate cannot read never reaches the file",
    caption:
      "Green: a command whose file operands can be read runs, and its receipt attributes the change. Red: a shape proven unreadable is denied before it runs, with the edit program to write instead.",
    lead: "Every change to a project file is recorded against the session that made it. The gate reads a Bash command before it runs; tugcast reads the receipt after.",
    spec: {
      form: "flow",
      columns: [
        [{ id: "model", name: "Model", sub: "a Bash call that writes a file" }],
        [
          {
            id: "gate",
            name: "PreToolUse gate",
            sub: "tugtool hook pre-tool-use",
            rows: [
              { key: 1, name: "Read the command", sub: "can its file operands be named?", does: "Parses the command line with the shell grammar and finds the files it writes.", where: "tugrust/crates/tugchanges-core/src/shell_ops.rs" },
              { key: 2, name: "Deny the unreadable", sub: "heredoc bodies, inline interpreters", does: "Refuses a shape it can prove unreadable, and prints the edit program to write instead.", where: "tugrust/crates/tugtool/src/commands/hook.rs" },
            ],
          },
        ],
        [
          {
            id: "cast",
            name: "tugcast",
            sub: "reads the tool result",
            rows: [
              { key: 3, name: "Find the receipt", sub: "TUG-FILE-RECEIPT in the output", does: "Reads the receipt marker out of the tool result's output.", where: "tugrust/crates/tugcast/src/feeds/attribution.rs" },
              { key: 4, name: "Record the change", sub: "against this session", does: "Writes the change to the shared ledger through the one ledger open.", where: "tugrust/crates/tugcore/src/ledger_db.rs" },
            ],
          },
        ],
        [
          {
            id: "ledger",
            name: "changes.db",
            sub: "what tugtool changes reads",
            rows: [
              { name: "attributed", mono: true, lit: "good" },
              { name: "unattributed", mono: true },
              { name: "foreign", mono: true },
            ],
          },
        ],
      ],
      edges: [
        { from: "model", to: "gate" },
        { from: "gate.1", to: "cast.1", tone: "good", label: "runs, prints its receipt" },
        { from: "gate.2", to: "model", tone: "bad", dashed: true, label: "denied before it runs" },
        { from: "cast.2", to: "ledger.1", tone: "good" },
      ],
    },
  },
  {
    id: "chart-fence",
    title: "A chart is laid out in a conversation between the page and the engine",
    caption:
      "Solid: a call. Dashed: its answer. The engine cannot measure text, so it asks the page for exactly the strings it needs and is called again.",
    lead: "The compiler runs in WASM, away from the page's fonts. A compile is at most three rounds, and the source stays on screen until the figure replaces it.",
    spec: {
      form: "sequence",
      actors: [
        { id: "md", name: "Markdown", sub: "block transformer" },
        { id: "render", name: "renderChartInto", sub: "the one renderer" },
        { id: "engine", name: "Engine", sub: "tuggraphics, WASM" },
        { id: "fonts", name: "Page fonts", sub: "role probes, canvas" },
      ],
      messages: [
        { key: 1, from: "md", to: "render", label: "fence closed: source", does: "Promotes a closed tugchart fence to a figure; an open one stays code.", where: "tugdeck/src/lib/markdown/block-transformers/tugchart.ts" },
        { key: 2, from: "render", to: "engine", label: "validate(source)", does: "Checks the spec; an invalid one shows its errors in place.", where: "tugdeck/crates/tuggraphics/src/chart/spec.rs" },
        { from: "engine", to: "render", label: "valid", reply: true },
        { key: 3, from: "render", to: "fonts", label: "wait for each role's face", does: "Waits for the faces the roles are set in, with a three-second horizon.", where: "tugdeck/src/lib/chart/chart-measure.ts" },
        { key: 4, from: "render", to: "engine", label: "compile_round(source, { })", does: "Runs one round of layout against the table of measurements so far.", where: "tugdeck/crates/tuggraphics-wasm/src/lib.rs" },
        { from: "engine", to: "render", label: "measure: these (role, text) pairs", reply: true },
        { key: 5, from: "render", to: "fonts", label: "measure each pair", does: "Measures exactly the pairs asked for, in the role's own computed font.", where: "tugdeck/src/lib/font-metrics.ts" },
        { from: "render", to: "engine", label: "compile_round(source, table)" },
        { from: "engine", to: "render", label: "done: svg, table, find text", reply: true, tone: "good" },
        { key: 6, from: "render", to: "render", label: "replace the source with the figure", does: "Builds the figure off-document and swaps it in with one write.", where: "tugdeck/src/lib/chart/render-chart.ts" },
      ],
    },
  },
  {
    id: "suite",
    title: "Five processes stand between a keystroke and Claude",
    caption: "Each band is a process; each arrow is what crosses the boundary beneath it.",
    lead: "Tug is a suite. The Session card is the surface, and everything under it exists to carry a turn to Claude Code and bring the answer back.",
    spec: {
      form: "layers",
      layers: [
        {
          name: "Tug.app",
          sub: "Swift macOS host",
          below: "hosts the page in web views",
          cells: [
            { key: 1, name: "Windows and menus", sub: "AppKit", does: "Owns the window, the menus and the native chords.", where: "tugapp/Sources" },
            { name: "Updates", sub: "Sparkle appcast" },
          ],
        },
        {
          name: "tugdeck",
          sub: "web frontend",
          below: "WebSocket frames",
          cells: [
            { key: 2, name: "Session card", sub: "prompt and transcript", does: "Where shell commands and AI turns share one surface.", where: "tugdeck/src/components/tugways/cards" },
            { name: "Deck", sub: "slots, panes, motion" },
            { name: "Themes", sub: "ten token files" },
          ],
        },
        {
          name: "tugcast",
          sub: "WebSocket multiplexer",
          below: "one bridge per session",
          cells: [
            { key: 3, name: "Feeds", sub: "attribution, reports", does: "Reads tool results as they pass and records what they say.", where: "tugrust/crates/tugcast/src/feeds" },
            { name: "Ledgers", sub: "sessions, changes" },
            { name: "Semantic index", sub: "on-device vectors" },
          ],
        },
        {
          name: "tugcode",
          sub: "Claude Code bridge",
          below: "stream-json over stdio",
          cells: [
            { key: 4, name: "Spawn config", sub: "flags, plugin dir", does: "Builds the argument list Claude Code is started with.", where: "tugcode/src/spawn-config.ts" },
            { name: "Event mapping", sub: "wire to protocol" },
          ],
        },
        {
          name: "claude",
          sub: "Claude Code",
          cells: [
            { key: 5, name: "tugplug", sub: "skills and prompt docs", does: "Teaches the model the Session card's fences, verbs and rules.", where: "tugplug" },
            { name: "Hooks", sub: "call back into tugtool" },
          ],
        },
      ],
    },
  },
];
