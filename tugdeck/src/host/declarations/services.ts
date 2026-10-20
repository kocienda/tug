/**
 * The host's services: pickers, the clipboard, the OS, the window's settings,
 * the menus, dictation, updates and the frame meter. Every payload here is
 * loose ([B02]) until the change that next touches it types it.
 *
 * @module host/declarations/services
 */

import { definePageCall, defineToHost, defineToPage, looseNumber, looseObject, looseReply, looseString } from "../declare";

export const sourceTreeToHost = defineToHost({
  name: "sourceTree",
  from: "shell",
  codec: looseObject({}),
  samples: [{}],
  refused: [true],
});

export const choosePathToHost = defineToHost({
  name: "choosePath",
  from: "any",
  codec: looseObject({ id: "path-1", kind: "directory" }),
  samples: [
    { id: "path-1", kind: "directory", initialPath: "~/src", suggestedName: null },
    { id: "path-2", kind: "file", initialPath: null, suggestedName: null },
  ],
  refused: ["path-1"],
});

export const getSettingsToHost = defineToHost({
  name: "getSettings",
  from: "any",
  codec: looseObject({}),
  samples: [{}],
  refused: [true],
});

export const setThemeToHost = defineToHost({
  name: "setTheme",
  from: "shell",
  codec: looseObject({ color: "#1c1e22" }),
  samples: [{ color: "#1c1e22" }],
  refused: ["#1c1e22"],
});

/** Swift answers it; no page writes it today. */
export const devBadgeToHost = defineToHost({
  name: "devBadge",
  from: "shell",
  codec: looseObject({ backend: false, app: false }),
  samples: [{ backend: true, app: false }],
  refused: [true],
});

export const clipboardReadToHost = defineToHost({
  name: "clipboardRead",
  from: "any",
  codec: looseObject({ requestId: "clip-1" }),
  samples: [{ requestId: "clip-1" }],
  refused: ["clip-1"],
});

export const clipboardWriteToHost = defineToHost({
  name: "clipboardWrite",
  from: "any",
  codec: looseObject({ text: "", atoms: "", html: "" }),
  samples: [{ text: "hello", atoms: "", html: "<p>hello</p>" }],
  refused: ["hello"],
});

export const clipboardWriteImageToHost = defineToHost({
  name: "clipboardWriteImage",
  from: "any",
  codec: looseObject({ base64: "" }),
  samples: [{ base64: "iVBORw0KGgo=" }],
  refused: ["iVBORw0KGgo="],
});

/** The menu-relevant state a page's aggregator publishes (`lib/host-menu-state.ts`). */
export const menuStateToHost = defineToHost({
  name: "menuState",
  from: "any",
  codec: looseObject({}),
  samples: [{ canUndo: false, canRedo: false, enabled: { "close-card": true } }],
  refused: [[]],
});

export const openPathToHost = defineToHost({
  name: "openPath",
  from: "any",
  codec: looseObject({ path: "~/CLAUDE.md", kind: "file" }),
  samples: [
    { path: "~/CLAUDE.md", kind: "file" },
    { path: "/tmp/shots/one.png", kind: "reveal" },
  ],
  refused: ["~/CLAUDE.md"],
});

export const lookUpInDictionaryToHost = defineToHost({
  name: "lookUpInDictionary",
  from: "any",
  codec: looseObject({ text: "" }),
  samples: [{ text: "lexicon", x: 120, y: 340, fontFamily: "Inter", fontSize: 14, bold: false, italic: false }],
  refused: ["lexicon"],
});

export const trashPathToHost = defineToHost({
  name: "trashPath",
  from: "any",
  codec: looseObject({ requestId: "trash-1", path: "" }),
  samples: [{ requestId: "trash-1", path: "~/Desktop/a.png" }],
  refused: ["~/Desktop/a.png"],
});

export const restorePathToHost = defineToHost({
  name: "restorePath",
  from: "any",
  codec: looseObject({ requestId: "trash-2", trashedPath: "", destination: "" }),
  samples: [{ requestId: "trash-2", trashedPath: "~/.Trash/a.png", destination: "~/Desktop/a.png" }],
  refused: ["~/.Trash/a.png"],
});

export const thumbnailPathToHost = defineToHost({
  name: "thumbnailPath",
  from: "any",
  codec: looseObject({ requestId: "thumb-1", path: "", size: 64 }),
  samples: [{ requestId: "thumb-1", path: "~/Documents/report.pdf", size: 64 }],
  refused: ["~/Documents/report.pdf"],
});

export const exportSessionToHost = defineToHost({
  name: "exportSession",
  from: "any",
  codec: looseObject({ id: "export-1" }),
  samples: [{ id: "export-1", baseName: "tug-session", markdown: "# Session", jsonl: "{}\n" }],
  refused: ["export-1"],
});

/** The name of one update-flow control, posted bare. */
export const updateActionToHost = defineToHost({
  name: "updateAction",
  from: "shell",
  codec: looseString("install"),
  samples: ["install", "later"],
  refused: [{ action: "install" }],
});

export const dictationToHost = defineToHost({
  name: "dictation",
  from: "any",
  codec: looseObject({ id: "d1", verb: "start" }),
  samples: [
    { id: "d1", verb: "start" },
    { id: "d1", verb: "finish" },
  ],
  refused: ["start"],
});

export const pageZoomToHost = defineToHost({
  name: "pageZoom",
  from: "any",
  codec: looseObject({ factor: 1 }),
  samples: [{ factor: 1.25 }],
  refused: [1.25],
});

export const hostFramesToHost = defineToHost({
  name: "hostFrames",
  from: "shell",
  codec: looseObject({ requestId: "frames-1", windowMs: 2000 }),
  samples: [{ requestId: "frames-1", windowMs: 2000 }],
  refused: ["frames-1"],
});

// Host → page.

export const settingsLoadedToPage = defineToPage({
  member: "onSettingsLoaded",
  to: "any",
  codec: looseObject({ makerMode: false, sourceTree: null }),
  samples: [
    { makerMode: true, sourceTree: "/Users/me/src/tug" },
    { makerMode: false, sourceTree: null },
  ],
  refused: [true],
});

/** Tugcast refused to start dev serving. No page receives it today. */
export const devModeErrorToPage = defineToPage({
  member: "onDevModeError",
  to: "shell",
  codec: looseString("the source tree has no tugdeck"),
  samples: ["the source tree has no tugdeck", "it's \"broken\"\nagain"],
  refused: [{ message: "x" }],
});

/** The source tree the user chose. No page receives it today. */
export const sourceTreeSelectedToPage = defineToPage({
  member: "onSourceTreeSelected",
  to: "shell",
  codec: looseString("/Users/me/src/tug"),
  samples: ["/Users/me/src/tug"],
  refused: [null],
});

/** The user dismissed the source-tree panel. No page receives it today. */
export const sourceTreeCancelledToPage = defineToPage({
  member: "onSourceTreeCancelled",
  to: "shell",
  codec: looseObject({}),
  samples: [{}],
  refused: [true],
});

export const pathChosenToPage = defineToPage({
  member: "onPathChosen",
  to: "any",
  codec: looseObject({ id: "tug-path-1", path: null }),
  samples: [
    { id: "tug-path-1", path: "/Users/me/notes.md" },
    { id: "tug-path-2", path: null },
  ],
  refused: ["tug-path-1"],
});

export const exportDoneToPage = defineToPage({
  member: "onExportDone",
  to: "any",
  codec: looseObject({ id: "tug-export-1", result: "canceled" }),
  samples: [
    { id: "tug-export-1", result: "saved" },
    { id: "tug-export-2", result: "canceled" },
  ],
  refused: ["saved"],
});

export const clipboardReadToPage = defineToPage({
  member: "onClipboardRead",
  to: "any",
  codec: looseObject({ requestId: "clip-1", text: "", html: "", atoms: "" }),
  samples: [{ requestId: "clip-1", text: "it's \"quoted\"\u2028and split", html: "<b>x</b>", atoms: "" }],
  refused: ["clip-1"],
});

export const trashResultToPage = defineToPage({
  member: "onTrashResult",
  to: "any",
  codec: looseObject({ requestId: "trash-1", ok: true }),
  samples: [
    { requestId: "trash-1", ok: true, trashedPath: "/Users/me/.Trash/a.png" },
    { requestId: "trash-2", ok: false, error: "outside the project" },
  ],
  refused: [false],
});

export const thumbnailToPage = defineToPage({
  member: "onThumbnail",
  to: "any",
  codec: looseObject({ requestId: "thumb-1", dataUrl: null }),
  samples: [
    { requestId: "thumb-1", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
    { requestId: "thumb-2", dataUrl: null },
  ],
  refused: [null],
});

/** What the host's display link read over a page's window. */
export const hostFramesToPage = defineToPage({
  member: "onHostFrames",
  to: "shell",
  codec: looseObject({ requestId: "frames-1", reading: {} }),
  samples: [{ requestId: "frames-1", reading: { windowMs: 2000, frames: 120, worstGapMs: 17.2 } }],
  refused: ["frames-1"],
});

export const dictationToPage = defineToPage({
  member: "onDictation",
  to: "any",
  codec: looseObject({ id: "d1", kind: "ready" }),
  samples: [
    { id: "d1", kind: "ready" },
    { id: "d1", kind: "volatile", text: "hello \"there\"" },
    { id: "d1", kind: "ended", reason: "finished" },
  ],
  refused: ["ready"],
});

export const updateStateToPage = defineToPage({
  member: "onUpdateState",
  to: "shell",
  codec: looseObject({ stage: "idle" }),
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
  refused: ["available"],
});

/** The window's standing zoom, with no transition. */
export const pageZoomToPage = defineToPage({
  member: "onPageZoom",
  to: "shell",
  codec: looseObject({ factor: 1 }),
  samples: [{ factor: 1.25 }],
  refused: [1.25],
});

/** A click on an inactive window, at its viewport point. */
export const activationClickToPage = defineToPage({
  member: "onActivationClick",
  to: "shell",
  codec: looseObject({ x: 0, y: 0 }),
  samples: [{ x: 412.5, y: 96 }],
  refused: [[412.5, 96]],
});

/** The host's network-path hint. */
export const networkPathToPage = defineToPage({
  member: "onNetworkPath",
  to: "shell",
  codec: looseObject({ status: "satisfied", isExpensive: false, isConstrained: false }),
  samples: [{ status: "unsatisfied", isExpensive: false, isConstrained: true }],
  refused: ["satisfied"],
});

/** A trackpad scroll's phase edge: `touched`, `lifted` or `momentum`. */
export const scrollPhaseToPage = defineToPage({
  member: "onScrollPhase",
  to: "any",
  codec: looseString("touched"),
  samples: ["touched", "lifted", "momentum"],
  refused: [{ edge: "touched" }],
});

/**
 * Write the deck root's zoom, and resolve once the new factor has painted and
 * whatever it re-tunes has landed. The host awaits it (`callAsyncJavaScript`).
 */
export const pageZoomApplyCall = definePageCall({
  receiver: "bridge",
  member: "onPageZoomApply",
  codec: looseNumber(1),
  replyCodec: looseReply(null),
  samples: [1.25, 0.5],
});
