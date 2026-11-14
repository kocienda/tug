/**
 * share-actions.ts — what the Share shade's Preview…, Copy, Save… and Share…
 * do.
 *
 * An artifact is made in one place ({@link makeArtifact}). It asks a private
 * session's confirmation once per visit, slices the marked turns, sends every
 * string they show through tugcast's scrub (secrets out, `$HOME` to `~`), and
 * writes the Markdown with its header. For a PDF or an image it then has the
 * host render the scrubbed slice through the card's own cells
 * (`shareRender`): a PDF of one continuous page, or an image of the whole
 * selection, however tall.
 *
 * Nothing leaves the machine unseen, and every action acts:
 *
 *  - **Preview…** makes the artifact and shows it in the host's preview sheet
 *    with only Done.
 *  - **Copy, Save… and Share…** act at once on the held artifact when it was
 *    previewed from exactly the current selection, tool mode and format. When
 *    it was not, the press makes the artifact and shows it in the preview
 *    sheet with a confirm button named for the action — Cancel beside it —
 *    and acts on the confirm. What leaves is always what was seen.
 *
 * Either way, once the sheet is dismissed the artifact is held as the preview
 * of the selection it was made from, so a second press acts at once. Every
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
/** The bulletin a press with nothing marked reads. */
export const NOTHING_MARKED_TEXT = "Select a turn to share";

/** An artifact, and the selection signature it was made from. */
interface MadeArtifact {
  signature: string;
  artifact: ShareArtifact;
}

/**
 * Make the marked turns' artifact in the store's format: scrubbed Markdown,
 * or a PDF or image the host rendered from it. `null` when nothing is marked,
 * a private session's confirmation is declined, the scrub or the render fails,
 * or share mode was left meanwhile — each said in the bulletin where the user
 * needs to hear it.
 */
async function makeArtifact(ctx: ShareActionContext): Promise<MadeArtifact | null> {
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
      return { signature, artifact: { format, markdown, path: "", html: "" } };
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
    return { signature, artifact: { format, markdown, path: outcome.path, html: outcome.html } };
  } finally {
    store.setRendering(false);
  }
}

/**
 * Show `made` in the host's preview sheet — with only Done when `confirm` is
 * empty, or with Cancel and a `confirm` button otherwise — and hold it as the
 * preview of its selection once the sheet is dismissed, since it has been
 * seen either way. Resolves whether the user went on: Done or the confirm
 * button, as against Cancel.
 */
async function showPreview(
  ctx: ShareActionContext,
  made: MadeArtifact,
  confirm: string,
): Promise<boolean> {
  const { artifact } = made;
  const result = await sharePreview(
    artifact.format === "markdown"
      ? { format: artifact.format, text: artifact.markdown, path: "" }
      : { format: artifact.format, text: "", path: artifact.path },
    confirm,
  );
  if (result === "unavailable") {
    ctx.notify()?.caution(SHARE_NEEDS_APP_TEXT);
    return false;
  }
  if (result === "failed") {
    ctx.notify()?.caution("Couldn't show the preview");
    return false;
  }
  if (!ctx.store.getSnapshot().active) return false;
  ctx.store.markPreviewed(made.signature, artifact);
  return result === "done";
}

/**
 * The artifact an outward action sends: the held one when it is the preview
 * of exactly this selection, tool mode and format; otherwise a fresh one,
 * shown first with `confirm` as the go-ahead. `null` when nothing is to be
 * sent — the user cancelled, or the artifact could not be made or shown.
 */
async function previewedArtifact(ctx: ShareActionContext, confirm: string): Promise<ShareArtifact | null> {
  const held = ctx.store.getSnapshot().lastArtifact;
  if (ctx.store.canSend() && held !== null) return held;
  const made = await makeArtifact(ctx);
  if (made === null) return null;
  return (await showPreview(ctx, made, confirm)) ? made.artifact : null;
}

/** Preview the marked turns in the shade's format, with only Done. */
export async function previewShare(ctx: ShareActionContext): Promise<void> {
  const made = await makeArtifact(ctx);
  if (made !== null) await showPreview(ctx, made, "");
}

/**
 * Copy the previewed artifact ([P13]): Markdown as plain text; a PDF as its
 * inline-styled HTML with the Markdown as the plain-text flavour; an image as
 * the PNG, with the Markdown beside it.
 */
export async function copyShare(ctx: ShareActionContext): Promise<void> {
  const artifact = await previewedArtifact(ctx, "Copy");
  if (artifact === null) return;
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
  const artifact = await previewedArtifact(ctx, "Save…");
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
 * Share the previewed artifact through the system share picker, anchored at
 * the rect `anchor` reads — the Share… button's, in this page's viewport,
 * read once any preview has closed.
 */
export async function pickShare(ctx: ShareActionContext, anchor: () => ShareAnchor | null): Promise<void> {
  const artifact = await previewedArtifact(ctx, "Share…");
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
