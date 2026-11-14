/**
 * share-actions.ts — what the Share shade's Preview…, Copy, Save… and Share…
 * do.
 *
 * An artifact is made in one place ({@link makeArtifact}). It asks a private
 * session's confirmation once per visit, slices the selected entries, sends every
 * string they show through tugcast's scrub (secrets out, `$HOME` to `~`), and
 * writes the Markdown with its header. For a PDF or an image it then has the
 * host render the scrubbed slice through the card's own cells
 * (`shareRender`): a PDF of one continuous page, or an image of the whole
 * selection, however tall.
 *
 * Every action does what its name says, at once:
 *
 *  - **Preview…** makes the artifact and shows it in the host's preview sheet
 *    with Done.
 *  - **Copy** writes it to the pasteboard, **Save…** raises the save panel,
 *    and **Share…** raises the system share picker. None of them shows a
 *    preview first: the preview is its own action, there for whoever wants
 *    to look before sending.
 *
 * An artifact, once made, is held as what its selection, tool mode and format
 * made, so the next action on the same three sends it without making it
 * again ({@link currentArtifact}). Every outcome — a refusal included —
 * lands in the card's pane bulletin ([L31]). The scrub carries its own
 * deadline, and the host answers each sheet and panel, so no action waits
 * without a horizon ([L33]).
 *
 * @module lib/share-actions
 */

import type { CodeSessionStore } from "./code-session-store";
import { shareCopyFile, sharePick, sharePreview, shareRender, shareSave, type ShareAnchor } from "./os-share";
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
import type { ShareArtifact, ShareTurnsStore } from "./share-turns-store";
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
  /** Whether the session is private, read when an artifact is made. */
  isPrivate: () => boolean;
  /** Ask whether a private session's turns may be rendered; `true` to go on. */
  confirmPrivate: () => Promise<boolean>;
  notify: () => ShareNotify | null;
}

/** The bulletin a scrub that did not answer, or answered short, reads. */
export const SCRUB_FAILED_TEXT = "Couldn't check the text for secrets";
/** The bulletin an action outside the app reads. */
export const SHARE_NEEDS_APP_TEXT = "Sharing needs the Tug app";
/** The bulletin a render that failed reads. */
export const RENDER_FAILED_TEXT = "Couldn't render the turns";
/** The bulletin a press with nothing selected reads. */
export const NOTHING_MARKED_TEXT = "Select a turn to share";

/**
 * Make the selected entries' artifact in the store's format — scrubbed
 * Markdown, or a PDF or image the host rendered from it — and hold it as
 * what this selection made. `null` when nothing is selected,
 * a private session's confirmation is declined, the scrub or the render fails,
 * or share mode was left meanwhile — each said in the bulletin where the user
 * needs to hear it.
 */
async function makeArtifact(ctx: ShareActionContext): Promise<ShareArtifact | null> {
  const { store, codeSessionStore } = ctx;
  const state = store.getSnapshot();
  if (state.rendering) return null;
  if (state.selected.size === 0) {
    ctx.notify()?.caution(NOTHING_MARKED_TEXT);
    return null;
  }
  if (ctx.isPrivate() && !state.privateConfirmed) {
    if (!(await ctx.confirmPrivate())) return null;
    store.confirmPrivate();
  }
  // What this artifact is of, captured now: a toggle while it is made leaves
  // the gate closed, by comparison.
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
      return null;
    }
    const markdown = shareDocumentMarkdown({
      turns: applied.slice,
      toolMode,
      header: applied.header,
    });
    // Mode left while the scrub ran: nothing to show it to.
    if (!store.getSnapshot().active) return null;
    if (format === "markdown") {
      const artifact: ShareArtifact = { format, markdown, path: "", html: "" };
      store.holdArtifact(signature, artifact);
      return artifact;
    }
    // The walk hands back the header it was given, scrubbed; a share always
    // has one, and an unscrubbed title never renders.
    if (applied.header === null) {
      ctx.notify()?.caution(SCRUB_FAILED_TEXT);
      return null;
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
    if (!store.getSnapshot().active) return null;
    if (outcome.result !== "ok") {
      ctx.notify()?.caution(RENDER_FAILED_TEXT);
      return null;
    }
    const artifact: ShareArtifact = { format, markdown, path: outcome.path, html: outcome.html };
    store.holdArtifact(signature, artifact);
    return artifact;
  } finally {
    store.setRendering(false);
  }
}

/**
 * The artifact an action shows or sends: the held one when it is of exactly
 * this selection, tool mode and format; otherwise a fresh one. `null` when
 * the artifact could not be made.
 */
async function currentArtifact(ctx: ShareActionContext): Promise<ShareArtifact | null> {
  const held = ctx.store.getSnapshot().lastArtifact;
  if (ctx.store.holdsCurrent() && held !== null) return held;
  return makeArtifact(ctx);
}

/** Show the selected entries, in the shade's format, in the host's preview sheet. */
export async function previewShare(ctx: ShareActionContext): Promise<void> {
  const artifact = await currentArtifact(ctx);
  if (artifact === null) return;
  const result = await sharePreview(
    artifact.format === "markdown"
      ? { format: artifact.format, text: artifact.markdown, path: "" }
      : { format: artifact.format, text: "", path: artifact.path },
  );
  if (result === "unavailable") ctx.notify()?.caution(SHARE_NEEDS_APP_TEXT);
  else if (result === "failed") ctx.notify()?.caution("Couldn't show the preview");
}

/**
 * Copy the artifact ([P13]): Markdown as plain text; a PDF or an image as
 * the rendered file itself, with the Markdown beside it as the plain-text
 * flavour. What pastes is the rendering as it was drawn — a PDF is not
 * re-expressed as HTML, which a mail client lays out its own way.
 */
export async function copyShare(ctx: ShareActionContext): Promise<void> {
  const artifact = await currentArtifact(ctx);
  if (artifact === null) return;
  if (artifact.format !== "markdown") {
    const result = await shareCopyFile(artifact.path, artifact.markdown);
    if (result === "unavailable") ctx.notify()?.caution(SHARE_NEEDS_APP_TEXT);
    else if (result !== "done") ctx.notify()?.caution("Couldn't copy the rendering");
    else ctx.notify()?.success("Copied");
    return;
  }
  if (!writeClipboardViaNative(artifact.markdown, "", "")) {
    ctx.notify()?.caution(SHARE_NEEDS_APP_TEXT);
    return;
  }
  ctx.notify()?.success("Copied");
}

/** Save the artifact through the host's save panel. */
export async function saveShare(ctx: ShareActionContext): Promise<void> {
  const artifact = await currentArtifact(ctx);
  if (artifact === null) return;
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
 * Share the artifact through the system share picker, anchored at the rect
 * `anchor` reads — the Share… button's, in this page's viewport, read once
 * the artifact is made.
 */
export async function pickShare(ctx: ShareActionContext, anchor: () => ShareAnchor | null): Promise<void> {
  const artifact = await currentArtifact(ctx);
  if (artifact === null) return;
  const rect = anchor();
  if (rect === null) return;
  const result = await sharePick(
    {
      format: artifact.format,
      text: artifact.format === "markdown" ? artifact.markdown : "",
      path: artifact.path,
    },
    rect,
  );
  if (result === "unavailable") ctx.notify()?.caution(SHARE_NEEDS_APP_TEXT);
  else if (result === "failed") ctx.notify()?.caution("Couldn't show the share picker");
  // "shown" → the picker speaks for itself.
}
