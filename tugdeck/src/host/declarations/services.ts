/**
 * The host's services: pickers, the clipboard, the OS, the window's settings,
 * the menus, dictation, updates and the frame meter.
 *
 * A payload here is typed field by field, as the geometry family's are: a
 * field the writer always writes is required, and a payload that does not
 * decode is refused whole. A payload that varies by kind is a union keyed on
 * its tag ([B04]).
 *
 * @module host/declarations/services
 */

import { INVALID, arr, bool, empty, literal, nullable, num, obj, oneOf, optional, rec, str, type Codec } from "../../bus/codec";
import { definePageCall, defineToHost, defineToPage, noReply } from "../declare";
import type { MenuCommandGate, MenuStateBodyPayload, MenuStatePayload } from "../../lib/host-menu-state";

export const sourceTreeToHost = defineToHost({
  name: "sourceTree",
  from: "shell",
  codec: empty,
  samples: [{}],
  refused: [true],
});

export const choosePathToHost = defineToHost({
  name: "choosePath",
  from: "any",
  codec: obj({
    id: str,
    kind: literal("directory", "file", "save", "insert"),
    initialPath: nullable(str),
    suggestedName: nullable(str),
  }),
  samples: [
    { id: "path-1", kind: "directory", initialPath: "~/src", suggestedName: null },
    { id: "path-2", kind: "save", initialPath: null, suggestedName: "Untitled-2" },
  ],
  refused: [
    "path-1",
    { id: "path-1", initialPath: null, suggestedName: null },
    { id: "path-1", kind: "folder", initialPath: null, suggestedName: null },
    { id: "path-1", kind: "file", suggestedName: null },
  ],
});

export const getSettingsToHost = defineToHost({
  name: "getSettings",
  from: "any",
  codec: empty,
  samples: [{}],
  refused: [true],
});

export const setThemeToHost = defineToHost({
  name: "setTheme",
  from: "shell",
  codec: obj({ color: str }),
  samples: [{ color: "#1c1e22" }],
  refused: ["#1c1e22", {}, { color: 0x1c1e22 }],
});

export const clipboardReadToHost = defineToHost({
  name: "clipboardRead",
  from: "any",
  codec: obj({ requestId: str }),
  samples: [{ requestId: "clip-1" }],
  refused: ["clip-1", { requestId: 7 }],
});

/** A copy's plain text, its atom sidecar and its rich text; `""` for a flavour it has none of. */
export const clipboardWriteToHost = defineToHost({
  name: "clipboardWrite",
  from: "any",
  codec: obj({ text: str, atoms: str, html: str }),
  samples: [
    { text: "hello", atoms: "", html: "<p>hello</p>" },
    { text: "hello", atoms: "{\"atoms\":[]}", html: "" },
  ],
  refused: ["hello", { text: "hello" }, { text: "hello", atoms: null, html: "" }],
});

export const clipboardWriteImageToHost = defineToHost({
  name: "clipboardWriteImage",
  from: "any",
  codec: obj({ base64: str }),
  samples: [{ base64: "iVBORw0KGgo=" }],
  refused: ["iVBORw0KGgo=", {}],
});

/**
 * A key equivalent in the host's alphabet. Each modifier is absent or a
 * boolean, and absent reads as up.
 */
const chordSpec = obj({
  keyEquivalent: str,
  command: optional(bool),
  shift: optional(bool),
  option: optional(bool),
  control: optional(bool),
});

/**
 * One menu item's gate. Every field is optional, because absence is a reading
 * of its own — "the host's tier keeps the item" — and `chord` has three: absent
 * leaves the key equivalent alone, `null` detaches it, a spec applies one.
 */
const menuCommandGate: Codec<MenuCommandGate> = obj({
  enabled: optional(bool),
  state: optional(oneOf(bool, literal("mixed"))),
  title: optional(str),
  chord: optional(nullable(chordSpec)),
});

const menuSessionBlock = obj({
  cardId: str,
  sessionBound: bool,
  canInterrupt: bool,
  canChangeSettings: bool,
  permissionMode: str,
  aiSummary: str,
  hasAssistantMessage: bool,
  hasTurns: bool,
  changesVisible: bool,
  historyVisible: bool,
  commitReady: bool,
  hasCustomName: bool,
});

const menuFileBlock = obj({
  cardId: str,
  mode: literal("manual", "automatic"),
  dirty: bool,
  untitled: bool,
  readOnly: bool,
  hasPath: bool,
  conflict: bool,
});

const menuEditBlock = obj({
  cut: bool,
  copy: bool,
  paste: bool,
  delete: bool,
  selectAll: bool,
  undo: bool,
  redo: bool,
  undoLabel: str,
  redoLabel: str,
  nativeUndoToken: num,
  find: bool,
  findNext: bool,
  findPrevious: bool,
});

/** The blocks that belong to the key card: all a body page posts. */
const menuCardBlocks = {
  session: nullable(menuSessionBlock),
  file: nullable(menuFileBlock),
  document: nullable(obj({ cardId: str })),
  edit: menuEditBlock,
  commands: rec(menuCommandGate),
};

const menuStatePayload: Codec<MenuStatePayload> = obj({
  panes: arr(obj({ id: str, title: str, focused: bool, cardCount: num, closable: bool })),
  spaces: arr(obj({ id: str, name: str, active: bool })),
  activeCard: nullable(obj({ cardId: str, component: str, closable: bool })),
  selectionActive: bool,
  stackDepth: num,
  ...menuCardBlocks,
  recentDocuments: arr(str),
  activeTheme: str,
  openQuickly: bool,
  captureArmed: bool,
  appModalOpen: bool,
});

const menuCardBlocksCodec = obj(menuCardBlocks);

/**
 * A body page's blocks. A payload carrying `panes`, which only the shell's
 * whole state carries, is never read as its blocks alone.
 */
const menuStateBodyPayload: Codec<MenuStateBodyPayload> = {
  decode: (v) => (typeof v === "object" && v !== null && "panes" in v ? INVALID : menuCardBlocksCodec.decode(v)),
  sample: menuCardBlocksCodec.sample,
};

const editIdle = {
  cut: false,
  copy: false,
  paste: false,
  delete: false,
  selectAll: false,
  undo: false,
  redo: false,
  undoLabel: "",
  redoLabel: "",
  nativeUndoToken: 0,
  find: false,
  findNext: false,
  findPrevious: false,
};

/**
 * The menu-relevant state a page's aggregator publishes
 * (`lib/host-menu-state.ts`): the shell's whole payload, or a body page's
 * card-scoped blocks, which the host merges over the shell's while the body's
 * card is the key card. The two are told apart by `panes`: a malformed whole
 * payload is refused, never read as its blocks alone.
 */
export const menuStateToHost = defineToHost<MenuStatePayload | MenuStateBodyPayload>({
  name: "menuState",
  from: "any",
  codec: oneOf(menuStatePayload, menuStateBodyPayload),
  samples: [
    {
      panes: [{ id: "p1", title: "Session", focused: true, cardCount: 1, closable: true }],
      spaces: [{ id: "s1", name: "Main", active: true }],
      activeCard: { cardId: "c1", component: "session", closable: true },
      selectionActive: true,
      stackDepth: 1,
      session: null,
      file: { cardId: "c1", mode: "manual", dirty: true, untitled: false, readOnly: false, hasPath: true, conflict: false },
      document: null,
      edit: { ...editIdle, undo: true, undoLabel: "Typing", nativeUndoToken: 3 },
      commands: {
        "view.zoomIn": { chord: { keyEquivalent: "+", command: true } },
        "card.close": { chord: null },
        "window.jots": { enabled: true, state: "mixed", title: "Hide Jots" },
      },
      recentDocuments: ["/a.md"],
      activeTheme: "ironclad",
      openQuickly: true,
      captureArmed: false,
      appModalOpen: false,
    },
    {
      session: {
        cardId: "c1",
        sessionBound: true,
        canInterrupt: false,
        canChangeSettings: true,
        permissionMode: "default",
        aiSummary: "",
        hasAssistantMessage: false,
        hasTurns: false,
        changesVisible: false,
        historyVisible: false,
        commitReady: false,
        hasCustomName: false,
      },
      file: null,
      document: { cardId: "c1" },
      edit: editIdle,
      commands: { "session.stop": { enabled: false, state: false } },
    },
  ],
  refused: [
    [],
    { canUndo: false, canRedo: false, enabled: { "close-card": true } },
    { session: null, file: null, document: null, edit: editIdle, commands: { x: { state: "sideways" } } },
    { session: null, file: null, document: null, edit: editIdle, commands: { x: { chord: { command: true } } } },
    { file: null, document: null, edit: editIdle, commands: {} },
    { panes: [], session: null, file: null, document: null, edit: editIdle, commands: {} },
  ],
});

export const openPathToHost = defineToHost({
  name: "openPath",
  from: "any",
  codec: obj({ path: str, kind: literal("file", "folder", "reveal") }),
  samples: [
    { path: "~/CLAUDE.md", kind: "file" },
    { path: "~/.claude/projects", kind: "folder" },
    { path: "/tmp/shots/one.png", kind: "reveal" },
  ],
  refused: ["~/CLAUDE.md", { path: "~/CLAUDE.md" }, { path: "~/CLAUDE.md", kind: "edit" }],
});

/** The selected text and the baseline origin and font its callout is drawn with. */
export const lookUpInDictionaryToHost = defineToHost({
  name: "lookUpInDictionary",
  from: "any",
  codec: obj({ text: str, x: num, y: num, fontFamily: str, fontSize: num, bold: bool, italic: bool }),
  samples: [{ text: "lexicon", x: 120, y: 340, fontFamily: "Inter", fontSize: 14, bold: false, italic: false }],
  refused: ["lexicon", { text: "lexicon" }, { text: "lexicon", x: "120", y: 340, fontFamily: "", fontSize: 14, bold: false, italic: false }],
});

export const trashPathToHost = defineToHost({
  name: "trashPath",
  from: "any",
  codec: obj({ requestId: str, path: str }),
  samples: [{ requestId: "trash-1", path: "~/Desktop/a.png" }],
  refused: ["~/Desktop/a.png", { requestId: "trash-1" }],
});

export const restorePathToHost = defineToHost({
  name: "restorePath",
  from: "any",
  codec: obj({ requestId: str, trashedPath: str, destination: str }),
  samples: [{ requestId: "trash-2", trashedPath: "~/.Trash/a.png", destination: "~/Desktop/a.png" }],
  refused: ["~/.Trash/a.png", { requestId: "trash-2", trashedPath: "~/.Trash/a.png" }],
});

export const thumbnailPathToHost = defineToHost({
  name: "thumbnailPath",
  from: "any",
  codec: obj({ requestId: str, path: str, size: num }),
  samples: [{ requestId: "thumb-1", path: "~/Documents/report.pdf", size: 64 }],
  refused: ["~/Documents/report.pdf", { requestId: "thumb-1", path: "~/Documents/report.pdf" }],
});

/** A session's two renderings, which the save panel's format popup chooses between. */
export const exportSessionToHost = defineToHost({
  name: "exportSession",
  from: "any",
  codec: obj({ id: str, baseName: str, markdown: str, jsonl: str }),
  samples: [{ id: "export-1", baseName: "tug-session", markdown: "# Session", jsonl: "{}\n" }],
  refused: ["export-1", { id: "export-1" }, { id: "export-1", baseName: "s", markdown: "# S", jsonl: null }],
});

/**
 * The name of one update-flow control, posted bare: `UpdateAction` in
 * `tugapp/Sources/UpdateState.swift`, one for one.
 */
export const updateActionToHost = defineToHost({
  name: "updateAction",
  from: "shell",
  codec: literal("install", "later", "skip", "cancel", "pause", "resume", "retry", "dismiss", "check"),
  samples: ["install", "later", "check"],
  refused: [{ action: "install" }, "sideways"],
});

/**
 * A dictation verb for the session `id`: `start` claims the mic, `stop`
 * truncates, `finish` asks for the settled reading of what was heard.
 */
export const dictationToHost = defineToHost({
  name: "dictation",
  from: "any",
  codec: obj({ id: str, verb: literal("start", "stop", "finish") }),
  samples: [
    { id: "d1", verb: "start" },
    { id: "d1", verb: "finish" },
  ],
  refused: ["start", { id: "d1", verb: "listen" }, { verb: "stop" }],
});

/** The Layout card's Zoom row asks for a level; the host owns the factor. */
export const pageZoomToHost = defineToHost({
  name: "pageZoom",
  from: "any",
  codec: obj({ factor: num }),
  samples: [{ factor: 1.25 }],
  refused: [1.25, { factor: "1.25" }],
});

export const hostFramesToHost = defineToHost({
  name: "hostFrames",
  from: "shell",
  codec: obj({ requestId: str, windowMs: num }),
  samples: [{ requestId: "frames-1", windowMs: 2000 }],
  refused: ["frames-1", { requestId: "frames-1" }, { requestId: 7, windowMs: 2000 }],
});

// Host → page.

/** The host's settings: the maker-mode gate and the source tree, null when unset. */
export const settingsLoadedToPage = defineToPage({
  member: "onSettingsLoaded",
  to: "any",
  codec: obj({ makerMode: bool, sourceTree: nullable(str) }),
  samples: [
    { makerMode: true, sourceTree: "/Users/me/src/tug" },
    { makerMode: false, sourceTree: null },
  ],
  refused: [true, { makerMode: "yes", sourceTree: null }, { sourceTree: null }],
});

/** The path a picker chose, or null when it was dismissed. */
export const pathChosenToPage = defineToPage({
  member: "onPathChosen",
  to: "any",
  codec: obj({ id: str, path: nullable(str) }),
  samples: [
    { id: "tug-path-1", path: "/Users/me/notes.md" },
    { id: "tug-path-2", path: null },
  ],
  refused: ["tug-path-1", { path: "/Users/me/notes.md" }, { id: "tug-path-1", path: 7 }],
});

export const exportDoneToPage = defineToPage({
  member: "onExportDone",
  to: "any",
  codec: obj({ id: str, result: literal("saved", "canceled") }),
  samples: [
    { id: "tug-export-1", result: "saved" },
    { id: "tug-export-2", result: "canceled" },
  ],
  refused: ["saved", { id: "tug-export-1", result: "failed" }, { result: "saved" }],
});

/** The pasteboard's plain text, rich text and atom sidecar; `""` for a flavour it has none of. */
export const clipboardReadToPage = defineToPage({
  member: "onClipboardRead",
  to: "any",
  codec: obj({ requestId: str, text: str, html: str, atoms: str }),
  samples: [{ requestId: "clip-1", text: "it's \"quoted\" and split", html: "<b>x</b>", atoms: "" }],
  refused: ["clip-1", { requestId: "clip-1", text: "x" }],
});

/** What a trash or a restore came to: where the file went, or why it did not move. */
export type TrashResult =
  | { readonly requestId: string; readonly ok: true; readonly trashedPath: string }
  | { readonly requestId: string; readonly ok: true; readonly restoredPath: string }
  | { readonly requestId: string; readonly ok: false; readonly error: string };

const trashResultCodec: Codec<TrashResult> = oneOf(
  obj({ requestId: str, ok: literal(true), trashedPath: str }),
  obj({ requestId: str, ok: literal(true), restoredPath: str }),
  obj({ requestId: str, ok: literal(false), error: str }),
);

export const trashResultToPage = defineToPage<TrashResult>({
  member: "onTrashResult",
  to: "any",
  codec: trashResultCodec,
  samples: [
    { requestId: "trash-1", ok: true, trashedPath: "/Users/me/.Trash/a.png" },
    { requestId: "trash-2", ok: true, restoredPath: "/Users/me/Desktop/a-2.png" },
    { requestId: "trash-3", ok: false, error: "outside the project" },
  ],
  refused: [false, { requestId: "trash-1", ok: true }, { requestId: "trash-1", ok: false, trashedPath: "/x" }],
});

/** A QuickLook thumbnail as a PNG data URL, or null when the file has none. */
export const thumbnailToPage = defineToPage({
  member: "onThumbnail",
  to: "any",
  codec: obj({ requestId: str, dataUrl: nullable(str) }),
  samples: [
    { requestId: "thumb-1", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
    { requestId: "thumb-2", dataUrl: null },
  ],
  refused: [null, { requestId: "thumb-1" }, { requestId: "thumb-1", dataUrl: false }],
});

/** One presentation sample of a metered layer: ms from arming, position, opacity. */
export interface HostFrameSample {
  t: number;
  x: number;
  y: number;
  opacity: number;
}

/** A window of host display-link ticks (Spec S06's `HostFrameReading`). */
export interface HostFrameReading {
  periodMs: number;
  ticks: number;
  expectedTicks: number;
  missed: number;
  worstGapMs: number;
  gapsOverPeriod: Array<{ atMs: number; gapMs: number }>;
  /** The single sampled layer's samples, when the meter was armed sampling one. */
  samples?: HostFrameSample[];
  /** The wall clock (ms since 1970) at the meter's arming; its `t` are from there. */
  armedWallMs: number;
  /** Every tick inside the window, ms from arming. */
  tickMs: number[];
  /**
   * Each layer the meter sampled by name — a carried body's container under
   * its card id — with the spans its beats move it over, and across those
   * the share of ticks its presentation advanced on and its longest still run.
   */
  layers: Record<
    string,
    {
      samples: HostFrameSample[];
      active: Array<{ fromMs: number; toMs: number }>;
      activeTicks: number;
      advancedRatio: number | null;
      worstStillMs: number;
    }
  >;
}

const sample: Codec<HostFrameSample> = obj({ t: num, x: num, y: num, opacity: num });

const hostFrameReadingCodec: Codec<HostFrameReading> = obj({
  periodMs: num,
  ticks: num,
  expectedTicks: num,
  missed: num,
  worstGapMs: num,
  gapsOverPeriod: arr(obj({ atMs: num, gapMs: num })),
  samples: optional(arr(sample)),
  armedWallMs: num,
  tickMs: arr(num),
  layers: rec(
    obj({
      samples: arr(sample),
      active: arr(obj({ fromMs: num, toMs: num })),
      activeTicks: num,
      advancedRatio: nullable(num),
      worstStillMs: num,
    }),
  ),
});

const reading: HostFrameReading = {
  periodMs: 8.33,
  ticks: 238,
  expectedTicks: 240,
  missed: 2,
  worstGapMs: 25,
  gapsOverPeriod: [{ atMs: 812.5, gapMs: 25 }],
  armedWallMs: 1760000000000.5,
  tickMs: [8.3, 16.7],
  layers: {},
};

/** What the host's display link read over a page's window. */
export const hostFramesToPage = defineToPage<{ requestId: string; reading: HostFrameReading }>({
  member: "onHostFrames",
  to: "shell",
  codec: obj({ requestId: str, reading: hostFrameReadingCodec }),
  samples: [
    { requestId: "frames-1", reading },
    {
      requestId: "frames-2",
      reading: {
        ...reading,
        samples: [{ t: 0, x: 10, y: 20, opacity: 1 }],
        layers: {
          c1: {
            samples: [{ t: 0, x: 10, y: 20, opacity: 1 }],
            active: [{ fromMs: 0, toMs: 300 }],
            activeTicks: 36,
            advancedRatio: 0.97,
            worstStillMs: 16.7,
          },
          c2: { samples: [], active: [], activeTicks: 0, advancedRatio: null, worstStillMs: 0 },
        },
      },
    },
  ],
  refused: ["frames-1", { requestId: "frames-1", reading: {} }, { requestId: "frames-1", reading: { ...reading, tickMs: undefined } }],
});

/** Why a dictation session never started. The button speaks each of these. */
export type DictationRefusalReason =
  | "microphone-permission"
  | "speech-permission"
  | "no-model"
  | "no-input-device"
  | "unavailable"
  | "error";

/** Why a live dictation session ended. */
export type DictationEndReason = "stopped" | "superseded" | "device-lost" | "error";

/**
 * One dictation event from the host: `DictationEvent` in
 * `tugapp/Sources/DictationState.swift`, keyed on `kind`.
 *
 * The ordering rules are the host's to keep: zero or more `preparing`, then
 * exactly one of `ready` or `refused`; after `ready`, any interleaving of
 * `volatile` and `final`, then exactly one `ended`, and nothing after it.
 * `volatile.text` is the whole provisional tail since the last `final` and
 * each one replaces the previous; the concatenation of every `final.text` is
 * the transcript.
 */
export type DictationEvent =
  | { id: string; kind: "preparing" }
  | { id: string; kind: "ready" }
  /** Reserved. The host never sends one: the live face is the wave. */
  | { id: string; kind: "level"; level: number }
  | { id: string; kind: "volatile"; text: string }
  | { id: string; kind: "final"; text: string }
  | { id: string; kind: "ended"; reason: DictationEndReason; message?: string }
  | { id: string; kind: "refused"; reason: DictationRefusalReason; message?: string };

const dictationEventCodec: Codec<DictationEvent> = oneOf(
  obj({ id: str, kind: literal("preparing") }),
  obj({ id: str, kind: literal("ready") }),
  obj({ id: str, kind: literal("level"), level: num }),
  obj({ id: str, kind: literal("volatile"), text: str }),
  obj({ id: str, kind: literal("final"), text: str }),
  obj({ id: str, kind: literal("ended"), reason: literal("stopped", "superseded", "device-lost", "error"), message: optional(str) }),
  obj({
    id: str,
    kind: literal("refused"),
    reason: literal("microphone-permission", "speech-permission", "no-model", "no-input-device", "unavailable", "error"),
    message: optional(str),
  }),
);

export const dictationToPage = defineToPage<DictationEvent>({
  member: "onDictation",
  to: "any",
  codec: dictationEventCodec,
  samples: [
    { id: "d1", kind: "preparing" },
    { id: "d1", kind: "ready" },
    { id: "d1", kind: "level", level: 0.4 },
    { id: "d1", kind: "volatile", text: "hello \"there\"" },
    { id: "d1", kind: "final", text: "hello there" },
    { id: "d1", kind: "ended", reason: "device-lost" },
    { id: "d1", kind: "ended", reason: "error", message: "the tap fell over" },
    { id: "d1", kind: "refused", reason: "no-model" },
  ],
  refused: [
    "ready",
    { id: "d1", kind: "listening" },
    { id: "d1", kind: "volatile" },
    { id: "d1", kind: "ended", reason: "finished" },
    { id: "d1", kind: "refused", reason: "superseded" },
    { id: "d1", kind: "ended", reason: "stopped", message: null },
  ],
});

/**
 * The update flow's state: `UpdateSnapshot` in
 * `tugapp/Sources/UpdateState.swift`.
 *
 * One object rather than a union keyed on `stage`, and on purpose: the host
 * writes every field in every stage (an `idle` snapshot still carries the
 * running version and the reveal count), and the store keeps the snapshot
 * whole, so a stage's variant would differ from the next only in which of
 * the same thirteen fields it reads, never in which it carries.
 */
export const updateStateToPage = defineToPage({
  member: "onUpdateState",
  to: "shell",
  codec: obj({
    stage: literal("idle", "checking", "available", "downloading", "paused", "extracting", "readyToInstall", "installing", "upToDate", "error"),
    version: str,
    build: str,
    currentVersion: str,
    releaseNotes: nullable(str),
    releaseNotesFailed: bool,
    userInitiated: bool,
    percent: nullable(num),
    receivedBytes: num,
    expectedBytes: num,
    message: str,
    cancellable: bool,
    revealCount: num,
  }),
  samples: [
    {
      stage: "available",
      version: "1.4.0",
      build: "140",
      currentVersion: "1.3.2",
      releaseNotes: null,
      releaseNotesFailed: false,
      userInitiated: true,
      percent: null,
      receivedBytes: 0,
      expectedBytes: 0,
      message: "",
      cancellable: false,
      revealCount: 1,
    },
  ],
  refused: [
    "available",
    { stage: "available" },
    {
      stage: "sideways",
      version: "",
      build: "",
      currentVersion: "1.3.2",
      releaseNotes: null,
      releaseNotesFailed: false,
      userInitiated: false,
      percent: null,
      receivedBytes: 0,
      expectedBytes: 0,
      message: "",
      cancellable: false,
      revealCount: 0,
    },
  ],
});

/** The window's standing zoom, with no transition. */
export const pageZoomToPage = defineToPage({
  member: "onPageZoom",
  to: "shell",
  codec: obj({ factor: num }),
  samples: [{ factor: 1.25 }],
  refused: [1.25, { factor: "1.25" }],
});

/** A click on an inactive window, at its viewport point. */
export const activationClickToPage = defineToPage({
  member: "onActivationClick",
  to: "shell",
  codec: obj({ x: num, y: num }),
  samples: [{ x: 412.5, y: 96 }],
  refused: [[412.5, 96], { x: 412.5 }],
});

/**
 * The host's network-path hint. `unknown` is a status this host build does
 * not know, which the store reads as no evidence at all.
 */
export const networkPathToPage = defineToPage({
  member: "onNetworkPath",
  to: "shell",
  codec: obj({
    status: literal("satisfied", "unsatisfied", "requiresConnection", "unknown"),
    isExpensive: bool,
    isConstrained: bool,
  }),
  samples: [
    { status: "unsatisfied", isExpensive: false, isConstrained: true },
    { status: "unknown", isExpensive: false, isConstrained: false },
  ],
  refused: ["satisfied", { status: "online", isExpensive: false, isConstrained: false }, { status: "satisfied" }],
});

/** A trackpad scroll's phase edge: `touched`, `lifted` or `momentum`. */
export const scrollPhaseToPage = defineToPage({
  member: "onScrollPhase",
  to: "any",
  codec: literal("touched", "lifted", "momentum"),
  samples: ["touched", "lifted", "momentum"],
  refused: [{ edge: "touched" }, "began"],
});

/**
 * Write the deck root's zoom, and resolve once the new factor has painted and
 * whatever it re-tunes has landed. The host awaits it (`callAsyncJavaScript`),
 * and the reply is only the settling: `null`.
 */
export const pageZoomApplyCall = definePageCall({
  receiver: "bridge",
  member: "onPageZoomApply",
  codec: num,
  replyCodec: noReply,
  samples: [1.25, 0.5],
  refused: ["1.25", { factor: 1.25 }, null],
  replies: [null],
  refusedReplies: [{ ok: true }, 0],
});
