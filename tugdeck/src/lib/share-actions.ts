/**
 * share-actions.ts — what the share bar's Preview…, Copy and Save… do.
 *
 * Preview… is the one place an artifact is made. It asks a private session's
 * confirmation once per visit, slices the marked turns, sends every string
 * they show through tugcast's scrub (secrets out, `$HOME` to `~`), and writes
 * the Markdown with its header. For a PDF or an image it then has the host
 * render the scrubbed slice through the card's own cells (`shareRender`):
 * an image past the host's height cap is refused, and the bar moves to PDF
 * with a bulletin rather than previewing anything. The artifact — the
 * Markdown, or the rendered file with the Markdown as its plain-text flavour
 * — is shown in the host's preview sheet, and when the sheet is dismissed it
 * is held as the preview of the selection it was made from, which is what
 * opens Copy and Save….
 *
 * Copy, Save… and Share… make nothing: they send the held artifact, so what
 * leaves is exactly what was seen. Each refuses unless the gate is open, and every
 * outcome — a refusal included — lands in the card's pane bulletin ([L31]).
 * The scrub carries its own deadline, and the host answers each sheet and
 * panel, so no action waits without a horizon ([L33]).
 *
 * @module lib/share-actions
 */

import type { CodeSessionStore } from "./code-session-store";
import { shareCopyImage, sharePick, sharePreview, shareRender, shareSave, type ShareAnchor } from "./os-share";
import { getOnScreenTheme } from "../contexts/theme-provider";
import { scrubShareTexts } from "./share-scrub";
import {
  applyShareStrings,
  buildShareRenderDocument,
  buildShareSlice,
  collectShareStrings,
  shareDocumentMarkdown,
  shareHeader,
  shareSignature,
  shareTurnNumbers,
} from "./share-turns";
import type { ShareTurnsStore } from "./share-turns-store";
import { resolveSessionIdentity } from "./session-identity";
import { writeClipboardViaNative } from "./tug-native-clipboard";
import { exportBaseName } from "./transcript-export";

/** Where an action's outcome is said. */
export interface ShareNotify {
  caution(text: string): void;
  success(text: string): void;
}

/** What the actions read and drive. */
export interface ShareActionContext {
  store: ShareTurnsStore;
  codeSessionStore: CodeSessionStore;
  tugSessionId: string;
  projectDir: string;
  /** The model the session's turns were answered by, for a rendering's cells; `null` when unknown. */
  modelName: () => string | null;
  /** Whether the session is private, read when Preview… is pressed. */
  isPrivate: () => boolean;
  /** Ask whether a private session's turns may be rendered; `true` to go on. */
  confirmPrivate: () => Promise<boolean>;
  notify: () => ShareNotify | null;
}

/** The bulletin a scrub that did not answer, or answered short, reads. */
export const SCRUB_FAILED_TEXT = "Couldn't check the text for secrets";
/** The bulletin an action outside the app reads. */
export const SHARE_NEEDS_APP_TEXT = "Sharing needs the Tug app";
/** The bulletin an image past the host's height cap reads; the format moves to PDF. */
export const TOO_TALL_TEXT = "Too tall for an image — switched to PDF";
/** The bulletin a render that failed reads. */
export const RENDER_FAILED_TEXT = "Couldn't render the turns";

/**
 * Preview the marked turns in the bar's format: scrubbed Markdown, or a PDF or
 * image the host rendered from it. On the sheet's dismissal the artifact is
 * held as the preview of the selection it was made from.
 */
export async function previewShare(ctx: ShareActionContext): Promise<void> {
  const { store, codeSessionStore } = ctx;
  const state = store.getSnapshot();
  if (state.rendering) return;
  if (state.selected.size === 0) {
    ctx.notify()?.caution("Pick a turn to share");
    return;
  }
  if (ctx.isPrivate() && !state.privateConfirmed) {
    if (!(await ctx.confirmPrivate())) return;
    store.confirmPrivate();
  }
  // What this preview is of, captured now: a toggle while it is prepared or
  // shown leaves the gate closed, by comparison.
  const signature = shareSignature(state);
  const { selected, toolMode, format } = state;
  store.setRendering(true);
  try {
    const snapshot = codeSessionStore.getSnapshot();
    const slice = buildShareSlice(snapshot.transcript, selected, toolMode);
    const header = shareHeader({
      identity: resolveSessionIdentity(ctx.tugSessionId, { projectDir: ctx.projectDir }),
      transcript: snapshot.transcript,
      selected,
      snapshot,
    });
    const scrubbed = await scrubShareTexts(collectShareStrings(slice, header));
    const applied = scrubbed === null ? null : applyShareStrings(slice, header, scrubbed);
    if (applied === null) {
      ctx.notify()?.caution(SCRUB_FAILED_TEXT);
      return;
    }
    const markdown = shareDocumentMarkdown({
      turns: applied.slice,
      toolMode,
      header: applied.header,
    });
    // Mode left while the scrub ran: nothing to show it to.
    if (!store.getSnapshot().active) return;
    let path = "";
    let html = "";
    if (format !== "markdown") {
      // The walk hands back the header it was given, scrubbed; a share always
      // has one, and an unscrubbed title never renders.
      if (applied.header === null) {
        ctx.notify()?.caution(SCRUB_FAILED_TEXT);
        return;
      }
      const renderDocument = buildShareRenderDocument({
        theme: getOnScreenTheme(),
        header: applied.header,
        toolMode,
        modelName: ctx.modelName(),
        slice: applied.slice,
        turnNumbers: shareTurnNumbers(applied.slice, snapshot.transcript, snapshot),
      });
      const outcome = await shareRender(format, JSON.stringify(renderDocument));
      if (!store.getSnapshot().active) return;
      if (outcome.result === "tooTall") {
        store.setFormat("pdf");
        ctx.notify()?.caution(TOO_TALL_TEXT);
        return;
      }
      if (outcome.result !== "ok") {
        ctx.notify()?.caution(RENDER_FAILED_TEXT);
        return;
      }
      path = outcome.path;
      html = outcome.html;
    }
    store.setRendering(false);
    const result = await sharePreview(
      format === "markdown" ? { format, text: markdown, path: "" } : { format, text: "", path },
    );
    if (result === "unavailable") {
      ctx.notify()?.caution(SHARE_NEEDS_APP_TEXT);
      return;
    }
    if (result === "failed") {
      ctx.notify()?.caution("Couldn't show the preview");
      return;
    }
    if (!store.getSnapshot().active) return;
    store.markPreviewed(signature, { format, markdown, path, html });
  } finally {
    store.setRendering(false);
  }
}

/**
 * Copy the previewed artifact ([P13]): Markdown as plain text; a PDF as its
 * inline-styled HTML with the Markdown as the plain-text flavour; an image as
 * the PNG, with the Markdown beside it.
 */
export async function copyShare(ctx: ShareActionContext): Promise<void> {
  const { store } = ctx;
  const artifact = store.getSnapshot().lastArtifact;
  if (!store.canSend() || artifact === null) {
    ctx.notify()?.caution("Preview the turns before sharing them");
    return;
  }
  if (artifact.format === "png") {
    const result = await shareCopyImage(artifact.path, artifact.markdown);
    if (result === "unavailable") ctx.notify()?.caution(SHARE_NEEDS_APP_TEXT);
    else if (result !== "done") ctx.notify()?.caution("Couldn't copy the image");
    else ctx.notify()?.success("Copied");
    return;
  }
  const html = artifact.format === "pdf" ? artifact.html : "";
  if (!writeClipboardViaNative(artifact.markdown, "", html)) {
    ctx.notify()?.caution(SHARE_NEEDS_APP_TEXT);
    return;
  }
  ctx.notify()?.success("Copied");
}

/** Save the previewed artifact through the host's save panel. */
export async function saveShare(ctx: ShareActionContext): Promise<void> {
  const { store } = ctx;
  const artifact = store.getSnapshot().lastArtifact;
  if (!store.canSend() || artifact === null) {
    ctx.notify()?.caution("Preview the turns before sharing them");
    return;
  }
  const result = await shareSave({
    format: artifact.format,
    text: artifact.format === "markdown" ? artifact.markdown : "",
    path: artifact.path,
    baseName: `${exportBaseName(ctx.tugSessionId)}-turns`,
  });
  if (result === "done") ctx.notify()?.success("Saved");
  else if (result === "unavailable") ctx.notify()?.caution(SHARE_NEEDS_APP_TEXT);
  else if (result === "failed") ctx.notify()?.caution("Couldn't save the turns");
  // "canceled" → no bulletin.
}

/**
 * Share the previewed artifact through the system share picker, anchored at
 * `anchor` — the Share… button's rect in this page's viewport.
 */
export async function pickShare(ctx: ShareActionContext, anchor: ShareAnchor): Promise<void> {
  const { store } = ctx;
  const artifact = store.getSnapshot().lastArtifact;
  if (!store.canSend() || artifact === null) {
    ctx.notify()?.caution("Preview the turns before sharing them");
    return;
  }
  const result = await sharePick(
    {
      format: artifact.format,
      text: artifact.format === "markdown" ? artifact.markdown : "",
      path: artifact.path,
    },
    anchor,
  );
  if (result === "unavailable") ctx.notify()?.caution(SHARE_NEEDS_APP_TEXT);
  else if (result === "failed") ctx.notify()?.caution("Couldn't show the share picker");
  // "shown" → the picker speaks for itself.
}
