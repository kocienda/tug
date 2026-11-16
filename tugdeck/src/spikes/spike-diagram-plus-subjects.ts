/**
 * spike-diagram-plus-subjects.ts — one subject per diagram form, twice: as
 * the `tugdiagram` spec the shipped form draws today, and as the spec the
 * proposed form would take, and beside them the changes that separate the
 * two.
 *
 * The `today` specs are the forms' own golden subjects
 * (`crates/tuggraphics/tests/diagram-golden/`), so the left-hand figure is
 * exactly what an `/explain` answer shows now.
 *
 * @module spikes/spike-diagram-plus-subjects
 */

import type { PlusSpec } from "./spike-diagram-plus-layout";

/** Where a change lands: the pen's look, the form's layout, or a new field in the spec. */
export type Kind = "look" | "layout" | "spec";

export interface Note {
  kind: Kind;
  /** The change, as a short imperative. */
  title: string;
  /** What is wrong today and what the change does about it. */
  body: string;
  /** Whether the right-hand figure already draws it. */
  drawn: boolean;
}

export interface Subject {
  form: "layers" | "stack" | "sequence" | "flow";
  /** What the form is for, in a clause. */
  purpose: string;
  /** The single thing most wrong with it today. */
  verdict: string;
  today: Record<string, unknown>;
  plus: PlusSpec;
  notes: Note[];
}

const LAYERS: Subject = {
  form: "layers",
  purpose: "the strata a request passes down, and what crosses each boundary",
  verdict:
    "The crossings are the subject of this form and they are its weakest marks: a thin grey arrow, off the band's centre, that cannot say which way anything goes.",
  today: {
    tugdiagram: 1,
    form: "layers",
    title: "Five processes stand between a keystroke and Claude",
    layers: [
      {
        name: "Tug.app", sub: "Swift macOS host", below: "hosts the page in web views",
        cells: [{ key: 1, name: "Windows and menus", sub: "AppKit" }, { name: "Updates", sub: "Sparkle appcast" }],
      },
      {
        name: "tugdeck", sub: "web frontend", below: "WebSocket frames",
        cells: [
          { key: 2, name: "Session card", sub: "prompt and transcript" },
          { name: "Deck", sub: "slots, panes, motion" },
          { name: "Themes", sub: "ten token files" },
        ],
      },
      {
        name: "tugcast", sub: "WebSocket multiplexer", below: "one bridge per session",
        cells: [
          { key: 3, name: "Feeds", sub: "attribution, reports" },
          { name: "Ledgers", sub: "sessions, changes" },
          { name: "Semantic index", sub: "on-device vectors" },
        ],
      },
      {
        name: "tugcode", sub: "Claude Code bridge", below: "stream-json over stdio",
        cells: [{ key: 4, name: "Spawn config", sub: "flags, plugin dir" }, { name: "Event mapping", sub: "wire to protocol" }],
      },
      {
        name: "claude", sub: "Claude Code",
        cells: [{ key: 5, name: "tugplug", sub: "skills and prompt docs" }, { name: "Hooks", sub: "call back into tugtool" }],
      },
    ],
  },
  plus: {
    form: "layers",
    layers: [
      {
        name: "Tug.app", sub: "Swift macOS host",
        cross: { via: "WKWebView", down: "native chords, menu actions", up: "window and focus requests" },
        cells: [{ key: 1, name: "Windows and menus", sub: "AppKit" }, { name: "Updates", sub: "Sparkle appcast" }],
      },
      {
        name: "tugdeck", sub: "web frontend",
        cross: { via: "WebSocket", down: "prompts, commands", up: "transcript and feed frames" },
        cells: [
          { key: 2, name: "Session card", sub: "prompt and transcript" },
          { name: "Deck", sub: "slots, panes, motion" },
          { name: "Themes", sub: "ten token files" },
        ],
      },
      {
        name: "tugcast", sub: "WebSocket multiplexer",
        cross: { via: "one bridge per session", down: "user messages", up: "protocol events" },
        cells: [
          { key: 3, name: "Feeds", sub: "attribution, reports" },
          { name: "Ledgers", sub: "sessions, changes" },
          { name: "Semantic index", sub: "on-device vectors" },
        ],
      },
      {
        name: "tugcode", sub: "Claude Code bridge",
        cross: { via: "stream-json over stdio", down: "input lines", up: "event lines" },
        cells: [{ key: 4, name: "Spawn config", sub: "flags, plugin dir" }, { name: "Event mapping", sub: "wire to protocol" }],
      },
      {
        name: "claude", sub: "Claude Code", tone: "outside",
        cells: [{ key: 5, name: "tugplug", sub: "skills and prompt docs" }, { name: "Hooks", sub: "call back into tugtool" }],
      },
    ],
  },
  notes: [
    {
      kind: "layout", drawn: true,
      title: "Centre the crossing on the band",
      body:
        "Today the arrow is centred on the cell area, which starts after the label column, and its label hangs off one side, so the pair reads as shoved right. A crossing belongs to the two bands, so it sits on their shared centre line and is laid out symmetrically about it.",
    },
    {
      kind: "look", drawn: true,
      title: "Give the arrow the weight of what it means",
      body:
        "1.5 px in muted ink with an 8 px head is the lightest mark in the figure, lighter than a cell's outline reads. Draw connectors at 2 px in full ink with an 11 px head, and let the gap between bands grow from 34 px to 58 px so the arrow has a shaft and is not two heads touching.",
    },
    {
      kind: "spec", drawn: true,
      title: "Say what goes each way",
      body:
        "One double-headed arrow says only that the layers talk. Replace `below` with a crossing of three parts, all optional: `via`, the channel, set in the code face in a chip between the arrows; `down`, what the upper layer sends; `up`, what comes back. Two one-way arrows replace the double-headed one whenever both directions are named. A crossing with only `down` is a single arrow pointing down.",
    },
    {
      kind: "spec", drawn: true,
      title: "Let a layer be outside",
      body:
        "The bottom layer here is not Tug's, and nothing says so. A `tone` of `outside` on a layer gives it the same wash an outside block has in `stack`, so the two forms agree on what that colour means.",
    },
    {
      kind: "look", drawn: true,
      title: "Rule the band's name off from its cells",
      body:
        "The name floats in the same space as the cells and reads as a cell without an outline. A faint rule between the label column and the cells makes it a heading.",
    },
    {
      kind: "spec", drawn: false,
      title: "Let a crossing start and end at a cell",
      body:
        "When one cell owns the boundary (the Session card owns the WebSocket, not Themes), a crossing could name `from` and `to` cells and be drawn between them. Not drawn here: it needs the cells of adjacent bands to line up, which equal widths per band do not give.",
    },
  ],
};

const STACK: Subject = {
  form: "stack",
  purpose: "the architecture: what sits on what, what is outside, what cuts across",
  verdict:
    "Its arrows carry nothing. What reaches an outside block is written inside the block as a sub-label, and what passes between two layers cannot be said at all.",
  today: {
    tugdiagram: 1,
    form: "stack",
    title: "Tug is four layers between you and Claude Code",
    columns: 4,
    above: [{ name: "You", sub: "keyboard, pointer, voice", span: [2, 3] }],
    layers: [
      { name: "Tug.app", sub: "macOS host", rows: [[{ name: "Windows and menus" }, { name: "Web views" }, { name: "Updates" }]] },
      {
        name: "tugdeck", sub: "web frontend",
        rows: [
          [{ key: 1, name: "Session card", sub: "shell commands and AI turns on one surface" }],
          [{ name: "Deck", sub: "slots and panes" }, { name: "Sidebar cards" }, { name: "Themes", sub: "ten token files" }],
        ],
      },
      {
        name: "tugcast", sub: "WebSocket multiplexer",
        rows: [[{ key: 2, name: "Feeds" }, { name: "Session ledger" }, { key: 3, name: "Semantic index" }, { name: "Operator" }]],
      },
      { name: "tugcode", sub: "bridge", span: [1, 2], rows: [[{ key: 4, name: "Spawn config" }, { name: "Event mapping" }]] },
    ],
    below: [
      { name: "Claude Code", sub: "stream-json over stdio", span: [1, 2] },
      { name: "Ledgers on disk", sub: "Application Support/Tug", span: [3, 4] },
    ],
    across: { title: "Shared", names: ["tugtool — the CLI", "tugcore — shared library", "tugproto — protocol types"] },
  },
  plus: {
    form: "stack",
    columns: 4,
    above: [{ name: "You", sub: "at the Mac", span: [2, 3], link: "keyboard, pointer, voice" }],
    layers: [
      {
        name: "Tug.app", sub: "macOS host", below: "WKWebView",
        rows: [[{ name: "Windows and menus" }, { name: "Web views" }, { name: "Updates" }]],
      },
      {
        name: "tugdeck", sub: "web frontend", below: "WebSocket frames",
        rows: [
          [{ key: 1, name: "Session card", sub: "shell commands and AI turns on one surface" }],
          [{ name: "Deck", sub: "slots and panes" }, { name: "Sidebar cards" }, { name: "Themes", sub: "ten token files" }],
        ],
      },
      {
        name: "tugcast", sub: "WebSocket multiplexer", below: "one bridge per session",
        rows: [[{ key: 2, name: "Feeds" }, { name: "Session ledger" }, { key: 3, name: "Semantic index" }, { name: "Operator" }]],
      },
      { name: "tugcode", sub: "bridge", span: [1, 2], rows: [[{ key: 4, name: "Spawn config" }, { name: "Event mapping" }]] },
    ],
    below: [
      { name: "Claude Code", sub: "the model's own CLI", span: [1, 2], link: "stream-json over stdio" },
      { name: "Ledgers on disk", sub: "Application Support/Tug", span: [3, 4], link: "SQLite, one writer" },
    ],
    across: { title: "Shared", names: ["tugtool — the CLI", "tugcore — shared library", "tugproto — protocol types"] },
  },
  notes: [
    {
      kind: "spec", drawn: true,
      title: "Label the arrow, not the block",
      body:
        "\"stream-json over stdio\" is not a fact about Claude Code; it is what the arrow carries. Give an outside block a `link` and draw it as a chip on the arrow. The block's `sub` goes back to describing the block.",
    },
    {
      kind: "spec", drawn: true,
      title: "Let adjacent layers say what passes between them",
      body:
        "Stacking implies \"sits on\" and nothing more. Take the `below` field `layers` already has: a layer that names it gets a labelled connector to the layer under it, centred on the columns the two share; a layer that does not keeps today's quiet 12 px gap.",
    },
    {
      kind: "look", drawn: true,
      title: "Use the same connector everywhere",
      body:
        "The 2 px, full-ink, 11 px-headed connector from `layers`, with the same chip. One arrow in the system, so a reader learns it once.",
    },
    {
      kind: "layout", drawn: true,
      title: "Centre a key with its name",
      body:
        "A keyed cell today pins the disc to the cell's top-left corner while the name stays centred, so Feeds and Semantic index wear their numbers in different places. Treat the disc and the name as one group and centre the group.",
    },
    {
      kind: "layout", drawn: false,
      title: "Say why a short layer is short",
      body:
        "tugcode covers two of four columns and the space beside it is blank, with a long arrow passing through it. Either let the arrow's chip sit in that space, as drawn, or let a spec name the gap (`beside`) so the absence is a statement.",
    },
    {
      kind: "spec", drawn: false,
      title: "Let an across bar say which layers it touches",
      body:
        "Every bar runs the full height. A `span` of layers on a bar would let tugproto stop at the two layers that speak the protocol.",
    },
  ],
};

const SEQUENCE: Subject = {
  form: "sequence",
  purpose: "messages between a few parties, in time order",
  verdict:
    "It lists messages but hides the structure of the exchange: which reply answers which call, who is working, and that the middle four messages are a loop.",
  today: {
    tugdiagram: 1,
    form: "sequence",
    title: "A chart is laid out in a conversation between the page and the engine",
    actors: [
      { id: "md", name: "Markdown", sub: "block transformer" },
      { id: "render", name: "renderChartInto", sub: "the one renderer" },
      { id: "engine", name: "Engine", sub: "tuggraphics, WASM" },
      { id: "fonts", name: "Page fonts", sub: "role probes, canvas" },
    ],
    messages: [
      { key: 1, from: "md", to: "render", label: "fence closed: source" },
      { key: 2, from: "render", to: "engine", label: "validate(source)" },
      { from: "engine", to: "render", label: "valid", reply: true },
      { key: 3, from: "render", to: "fonts", label: "wait for each role's face" },
      { key: 4, from: "render", to: "engine", label: "compile_round(source, { })" },
      { from: "engine", to: "render", label: "measure: these (role, text) pairs", reply: true },
      { key: 5, from: "render", to: "fonts", label: "measure each pair" },
      { from: "render", to: "engine", label: "compile_round(source, table)" },
      { from: "engine", to: "render", label: "done: svg, table, find text", reply: true, tone: "good" },
      { key: 6, from: "render", to: "render", label: "replace the source with the figure" },
    ],
  },
  plus: {
    form: "sequence",
    actors: [
      { id: "md", name: "Markdown", sub: "block transformer" },
      { id: "render", name: "renderChartInto", sub: "the one renderer" },
      { id: "engine", name: "Engine", sub: "tuggraphics, WASM" },
      { id: "fonts", name: "Page fonts", sub: "role probes, canvas" },
    ],
    messages: [
      { key: 1, from: "md", to: "render", label: "fence closed: source" },
      { key: 2, from: "render", to: "engine", label: "validate(source)" },
      { from: "engine", to: "render", label: "valid", reply: true },
      { key: 3, from: "render", to: "fonts", label: "wait for each role's face" },
      { key: 4, from: "render", to: "engine", label: "compile_round(source, { })" },
      { from: "engine", to: "render", label: "measure: these (role, text) pairs", reply: true },
      { key: 5, from: "render", to: "fonts", label: "measure each pair" },
      { from: "render", to: "engine", label: "compile_round(source, table)" },
      { from: "engine", to: "render", label: "done: svg, table, find text", reply: true, tone: "good" },
      { key: 6, from: "render", to: "render", label: "replace the source with the figure" },
    ],
    phases: [
      { label: "Promote", from: 0, to: 0 },
      { label: "Check", from: 1, to: 3 },
      { label: "Measure", note: "repeats until nothing is left to measure", from: 4, to: 8 },
      { label: "Swap", from: 9, to: 9 },
    ],
  },
  notes: [
    {
      kind: "layout", drawn: true,
      title: "Put the key on the message, at the sender",
      body:
        "The discs stand in a gutter at the far left, a column away from the arrows they number, and the eye has to carry a row across. Seat each disc on the sending lifeline, where the arrow starts: it numbers the message and marks who acts. An unkeyed call gets a small dot in the same place.",
    },
    {
      kind: "layout", drawn: true,
      title: "Show who is working",
      body:
        "A narrow bar on a lifeline from the call an actor receives to the return it sends. The engine's three bars show at a glance that it is called three times and holds nothing between calls.",
    },
    {
      kind: "spec", drawn: true,
      title: "Name the phases",
      body:
        "A new `phases` list, each a label, an optional note and a run of messages, drawn as a faint band behind the run with its label in the freed gutter. It is the one place to say \"this part repeats\", which the form cannot say now.",
    },
    {
      kind: "look", drawn: true,
      title: "Make a return a different shape from a call",
      body:
        "A return today differs from a call by dashes and a shade of grey. Give it an open head as well: a call is a solid line with a filled head, a return a dashed line with an open one. The difference then survives a tone and a light theme.",
    },
    {
      kind: "layout", drawn: true,
      title: "Space by exchange, not by row",
      body:
        "Every row is one pitch from the next. Pull a return up under its call and give a new exchange a full step, so call and answer read as a pair.",
    },
    {
      kind: "look", drawn: true,
      title: "Strengthen the lifelines and name them at the foot",
      body:
        "The lifelines are nearly invisible, and by the tenth message the actor boxes are a screen away. Draw the lifelines at readable strength and repeat each actor's name where its line ends.",
    },
    {
      kind: "spec", drawn: false,
      title: "Allow a note on a lifeline",
      body:
        "A short `note` pinned to an actor between two messages (\"the table is complete here\") would carry state, which no message can.",
    },
  ],
};

const FLOW: Subject = {
  form: "flow",
  purpose: "work moving through parts, left to right, with branches",
  verdict:
    "Labels are parked away from the edges they name, a refusal goes the long way round the box it leaves, and what the three colours mean is said nowhere in the figure.",
  today: {
    tugdiagram: 1,
    form: "flow",
    title: "A shell edit the gate cannot read never reaches the file",
    columns: [
      [{ id: "model", name: "Model", sub: "a Bash call that writes a file" }],
      [
        {
          id: "gate", name: "PreToolUse gate", sub: "tugtool hook pre-tool-use",
          rows: [
            { key: 1, name: "Read the command", sub: "can its file operands be named?" },
            { key: 2, name: "Deny the unreadable", sub: "heredoc bodies, inline interpreters" },
          ],
        },
      ],
      [
        {
          id: "cast", name: "tugcast", sub: "reads the tool result",
          rows: [
            { key: 3, name: "Find the receipt", sub: "TUG-FILE-RECEIPT in the output" },
            { key: 4, name: "Record the change", sub: "against this session" },
          ],
        },
      ],
      [
        {
          id: "ledger", name: "changes.db", sub: "what tugtool changes reads",
          rows: [
            { name: "attributed", mono: true, lit: "good" },
            { name: "unattributed", mono: true, lit: "caution" },
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
      { from: "gate", to: "ledger", tone: "caution", label: "unprovable either way: runs, lands unattributed" },
    ],
  },
  plus: {
    form: "flow",
    columns: [
      [{ id: "model", name: "Model", sub: "a Bash call that writes a file" }],
      [
        {
          id: "gate", name: "PreToolUse gate", sub: "tugtool hook pre-tool-use",
          rows: [
            { key: 1, name: "Read the command", sub: "can its file operands be named?" },
            { key: 2, name: "Deny the unreadable", sub: "heredoc bodies, inline interpreters" },
          ],
        },
      ],
      [
        {
          id: "cast", name: "tugcast", sub: "reads the tool result",
          rows: [
            { key: 3, name: "Find the receipt", sub: "TUG-FILE-RECEIPT in the output" },
            { key: 4, name: "Record the change", sub: "against this session" },
          ],
        },
      ],
      [
        {
          id: "ledger", name: "changes.db", sub: "what tugtool changes reads",
          rows: [
            { name: "attributed", mono: true, lit: "good" },
            { name: "unattributed", mono: true, lit: "caution" },
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
      { from: "gate", to: "ledger.2", tone: "caution", label: "unprovable either way: runs, lands unattributed" },
    ],
    legend: [
      { tone: "good", text: "read and recorded" },
      { tone: "bad", text: "refused" },
      { tone: "caution", text: "ran, but nobody can say what it wrote" },
    ],
  },
  notes: [
    {
      kind: "layout", drawn: true,
      title: "Seat every label on its edge",
      body:
        "\"denied before it runs\" sits under a loop, nearer to a different edge than its own, and only its colour says whose it is. Put each label in a chip on the edge's longest run, in the edge's tone, with the line running into it and out again. A gap between columns is sized to the chip that crosses it, which costs width: this figure comes out a little wider than today's 1,017 px, so a chip wraps at 96 px and the form's budget wants checking against real figures.",
    },
    {
      kind: "layout", drawn: true,
      title: "Send a back edge the short way",
      body:
        "The refusal leaves row 2 on the right, wraps under the gate and climbs into the Model from below: five turns to say \"back to where it came from\". An edge to the neighbouring column on the left leaves the row's left side and crosses the one gap.",
    },
    {
      kind: "look", drawn: true,
      title: "Mark where an edge leaves",
      body:
        "A 2 px connector with the larger head, and a dot at its origin. With two edges leaving one box 30 px apart, the dot is what says which row each one belongs to.",
    },
    {
      kind: "layout", drawn: true,
      title: "Give each long edge a lane of its own",
      body:
        "An edge that skips a column runs under the boxes. Today two of them share nearly the same depth and their labels sit side by side beneath. Each gets its own lane, 30 px apart, with its chip on the lane.",
    },
    {
      kind: "spec", drawn: true,
      title: "Name the tones in the figure",
      body:
        "A new `legend` list, one line per tone used, drawn under the figure. The caption sentence still says how to read the figure; the legend is what survives when the figure is copied or shared without it.",
    },
    {
      kind: "look", drawn: true,
      title: "Light a row with more than its text",
      body:
        "A lit row today is a row whose name is coloured. Give it a wash, an outline and a dot in its tone, so it reads as an outcome and still reads without colour vision.",
    },
    {
      kind: "spec", drawn: false,
      title: "Mark where the flow starts and where it ends",
      body:
        "Nothing distinguishes the box work enters at from the ones it ends in. A `start` flag on a box (a filled dot before it) and an `end` flag (a doubled outline) would say so without a sentence.",
    },
  ],
};

export const SUBJECTS: readonly Subject[] = [LAYERS, STACK, SEQUENCE, FLOW];
