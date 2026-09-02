/**
 * overview-card.tsx — the **Overview** card: the app's narration channel, read as
 * a transcript.
 *
 * One scrolling column of posts, oldest at the top, newest at the bottom, in
 * the order they were written. Three voices share it — the Observer, which
 * digests session work as it happens; the Operator, which answers questions;
 * and the user, who asks them. The channel is app-wide, not per-session: a
 * post names the session it narrates through its refs rather than by living
 * inside that card.
 *
 * The rows are a transcript: each post is a {@link TugTranscriptEntry} wearing
 * the Session card's own attribution line — its icon size, its gutter, its
 * identifier, its stamp, its header surface, overridden nowhere. The narrated
 * session's citation leads the provenance strip under the body; copy sits in
 * the Z1B footer beneath that, where the Session card puts copy. Post bodies are
 * markdown, rendered by the transcript's own {@link TugMarkdownBlock}; ⌘C and
 * the right-click menu work per row through the shared transcript cell wiring
 * and reconstruct markdown from the rendered DOM.
 *
 * **The prose is annotated, not matched.** A post body goes through the
 * markdown pipeline, whose enhancer chain runs the app's own content
 * annotator over every block: it scans the text and marks every path and
 * every sha it finds, against resolvers pointed at that post's own
 * `projectDir`. So a file named in a sentence is clickable because it is in
 * the sentence, and a backticked one is clickable because it is backticked.
 * The refs the model listed alongside its prose are a SEPARATE list, written
 * independently and overlapping only by accident; they are used for one
 * thing, the trailing provenance strip, and only for the entries the prose
 * never named ({@link unmentionedRefs}).
 *
 * That split is the correction to what this did before: a bespoke matcher
 * placed atoms by looking for the ref list's targets inside the body, so a
 * mention the model had not also listed stayed dead text while an unrelated
 * listed ref was appended as a chip — the prose and the atoms describing
 * two different things. The annotator has no such blind spot.
 *
 * A trailing ref is the app's own {@link TugAtomRef} — the read-only atom
 * skin, glyph plus a name — resolved through {@link resolveOverviewRef} and
 * wrapped in the full annotation payload so the registry's click and context
 * menu are its gesture; an unconfirmed ref is inert with the reason on its
 * tooltip. A commit ref names itself — `commit:<8ch>` — because unlike an
 * inline mention it has no sentence around it, and its hover carries the
 * commit's subject, author and files.
 *
 * The composer is the session prompt-entry's core: a {@link TugEntryShell}
 * holding the CM6 {@link TugTextEditor} substrate (with `@` file-atom
 * completion) and the Z5-style submit button in the toolbar's trailing slot.
 * No Z2 status bar, no Z4A route picker, no Z4B indicators — just the field
 * and the button.
 *
 * ⌥⌘↑ / ⌥⌘↓ step the column one post at a time, the Session transcript's own
 * chord over this card's column and its own selection rule
 * ({@link computePageNavigation}). The card answers the registry's
 * `PREVIOUS_TURN` / `NEXT_TURN` on its `card-content` responder, which is what
 * makes the gesture work from anywhere focus sits in the rail.
 *
 * The column follows its live edge while the reader is at it, and says so: the
 * shared {@link TugJumpToBottomButton} floats over the column whenever they
 * are not, and clicking it jumps back and re-engages. Follow-state has one
 * writer (`setFollowing`), which moves the ref and the button's `data-visible`
 * in the same statement, and one geometric reading (`atBottom`). The pin is
 * driven by a `ResizeObserver` as well as by the render, because a
 * transcript's height moves for reasons no render reports — markdown settling,
 * an annotator verdict landing, the composer growing a row under the typing.
 *
 * Laws: [L02] the channel enters through `useOverview`'s
 * `useSyncExternalStore`; [L06] the follow-the-bottom scroll and the
 * composer's `data-empty` bridge are DOM writes, never React state; [L12] the
 * card's selection boundary is `CardHost`'s per-card registration — the
 * transcript needs no second entry; [L19]/[L20] module docstring, exported
 * props, `data-slot`, tokens scoped to the card's own slot.
 *
 * @module components/overview/overview-card
 */

import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { EditorView } from "@codemirror/view";
import { ArrowUp, Check, Folder } from "lucide-react";

import { BlockCopyButton } from "@/components/tugways/body-kinds/affordances/block-copy-button";
import { formatDurationMs } from "@/components/tugways/cards/session-card-telemetry-renderers";
import {
  formatTranscriptTimestamp,
  useTranscriptCellMenu,
  type CopyMarkdownResolver,
} from "@/components/tugways/cards/transcript-host-helpers";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugEntryShell } from "@/components/tugways/tug-entry-shell";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugAtomRef } from "@/components/tugways/tug-atom-ref";
import { TugAttachmentPreview } from "@/components/tugways/cards/tug-attachment-preview";
import { TugSessionCitation } from "@/components/tugways/tug-session-identity";
import {
  TugTextEditor,
  type TugTextEditorDelegate,
} from "@/components/tugways/tug-text-editor";
import {
  TugTranscriptEntry,
  type Participant,
} from "@/components/tugways/tug-transcript-entry";
import { TugJumpToBottomButton } from "@/components/tugways/tug-jump-to-bottom-button";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useResponder } from "@/components/tugways/use-responder";
import { computePageNavigation } from "@/components/tugways/internal/list-view-page-navigation";
import {
  getAtomsInState,
  removeAtomById,
} from "@/components/tugways/tug-text-editor/atom-decoration";
import { AnnotationScope } from "@/components/tugways/annotation-scope";
import { clipboardOriginProps } from "@/lib/clipboard-origin";
import { useAnnotationPortals } from "@/components/tugways/annotation-portals";
import {
  ANNOTATION_CLASS,
  type AnnotationContext,
} from "@/lib/annotator/types";
import {
  commitResolverFor,
  NO_COMMIT_VERDICT,
} from "@/lib/annotator/commit-resolution";
import { commitTip, dashTip, fileTip } from "@/components/tugways/entity-tips";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { dispatchCommand } from "@/command-dispatch";
import { fileNameResolverFor } from "@/lib/annotator/file-name-resolution";
import { useAnnotationClicks } from "@/components/tugways/use-annotation-clicks";
import { pathResolutionStore } from "@/lib/annotator/path-resolution";
import { dataAttributesForPayload } from "@/lib/annotator/payloads";
import { makeReferenceResolver } from "@/lib/annotator/resolve-reference";
import { resolveSessionRef } from "@/lib/annotator/session-resolution";
import { VerdictBatcher } from "@/lib/annotator/verdict-batching";
import { sessionCitationStore } from "@/lib/session-citation-store";
import { endStateBadgeFor } from "@/lib/code-session-store/end-state";
import {
  acquireWorkspace,
  getWorkspace,
  subscribeWorkspaces,
} from "@/lib/default-workspace-store";
import {
  createAtomBytesStore,
  type AtomBytesStore,
} from "@/lib/atom-bytes-store";
import { EditorSettingsStore } from "@/lib/editor-settings-store";
import {
  overviewAttachmentBytesStore,
  hydrateOverviewAttachments,
} from "@/lib/overview-attachment-bytes";
import { FeedStore } from "@/lib/feed-store";
import { FileTreeStore } from "@/lib/filetree-store";
import { getConnection } from "@/lib/connection-singleton";
import { unmentionedRefs } from "@/lib/overview-body-segments";
import {
  resolveOverviewRef,
  type OverviewRefResolution,
  type OverviewRefRoot,
} from "@/lib/overview-ref-resolve";
import {
  getOverviewStore,
  useOverview,
  LOAD_OLDER_PX,
  type OverviewPostEntry,
} from "@/lib/overview-store";
import { selectionToTranscriptSubstrate } from "@/lib/markdown/serialize-selection";
import { buildSlashCommandLine } from "@/lib/slash-commands";
import type { AtomSegment } from "@/lib/tug-atom-img";
import type { CompletionProvider } from "@/lib/tug-text-types";
import {
  FeedId,
  type OverviewAuthor,
  type OverviewInputAttachment,
  type OverviewRef,
} from "@/protocol";
import "./overview-card.css";

/** How close to the bottom still counts as "following", in px. Slack for a
 *  sub-pixel scroll height and for the reader who nudged the wheel once. */
const FOLLOW_SLACK_PX = 24;

/**
 * The card's focus group — one group for every stop the card offers, walked
 * in the order the eye reads them. The composer's two controls (field, then
 * submit) are the stops; the transcript's posts are not stops yet.
 */
const OVERVIEW_FOCUS_GROUP = "overview-card";

/** Props for {@link OverviewContent}. */
export interface OverviewContentProps {
  /** The host card's id — the card's own identity, stamped for tests. */
  cardId: string;
}

/** Human-readable name of each voice — the row's identifier. */
const AUTHOR_LABEL: Record<OverviewAuthor, string> = {
  observer: "Observer",
  operator: "Operator",
  user: "You",
  tripwire: "Tripwire",
};

/** The transcript participant each Overview voice renders as. */
const AUTHOR_PARTICIPANT: Record<OverviewAuthor, Participant> = {
  observer: "observer",
  operator: "operator",
  user: "user",
  tripwire: "tripwire",
};

/**
 * A post's time, in the reader's locale — {@link formatTranscriptTimestamp},
 * the Session transcript's own stamp, down to the seconds and the U+2236
 * separator. A post from today shows its clock alone, an older post names its
 * day, which matters more here than there: the Overview spans days. The full
 * stamp always rides the `title`.
 */
function useTimeFormats(): {
  short: (at: Date) => string;
  full: Intl.DateTimeFormat;
} {
  return useMemo(
    () => ({
      short: (at: Date) => formatTranscriptTimestamp(at.getTime()),
      full: new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    }),
    [],
  );
}

/**
 * The wrapper attributes a resolved ref's atom wears — the annotation
 * contract, FULLY stamped: kind plus the payload's whole dataset
 * ({@link dataAttributesForPayload}), which is what lets the delegated
 * click layer and the row's context menu read a real payload back off the
 * element. A kind attribute alone is a half-stamped annotation, and the
 * reader treats those as misses — the bug this stamping replaced.
 */
function annotationProps(
  ref: OverviewRef,
  resolution: OverviewRefResolution,
): Record<string, unknown> {
  const marks = {
    "data-overview-ref-kind": ref.kind,
    "data-overview-ref-target": ref.target,
  };
  if (resolution.state === "actionable") {
    return {
      ...marks,
      className: ANNOTATION_CLASS,
      "data-tug-annotation": resolution.payload.kind,
      ...dataAttributesForPayload(resolution.payload),
      // Opening a card must not move DOM focus with the press.
      "data-tug-focus": "refuse",
      "data-no-activate": "",
    };
  }
  return marks;
}

/**
 * What a ref's hover says, and in which bubble — never the OS's.
 *
 * A resolved ref is an entity and gets the entity tip its kind already has:
 * a commit's is {@link commitTip}, everything else names a path and gets
 * {@link fileTip}. An unresolved one is not describing an entity at all —
 * it is reporting on a lookup — so it speaks in the plain label bubble, the
 * same one every other hint in the app uses.
 */
function refTip(
  ref: OverviewRef,
  resolution: OverviewRefResolution,
): { content: React.ReactNode; variant: "label" | "entity" } {
  if (resolution.state === "pending") {
    return {
      content: `${ref.kind}: ${ref.target} — checking…`,
      variant: "label",
    };
  }
  if (resolution.state !== "actionable") {
    return {
      content: `${ref.kind}: ${ref.target} — ${resolution.reason}`,
      variant: "label",
    };
  }
  if (ref.kind === "commit" && resolution.facts !== undefined) {
    return {
      content: commitTip({
        sha: ref.target,
        subject: resolution.facts.subject,
        author: resolution.facts.author,
        date: resolution.facts.date,
        files: resolution.facts.files,
      }),
      variant: "entity",
    };
  }
  return { content: fileTip({ path: ref.target }), variant: "entity" };
}

/**
 * One trailing ref atom — provenance the prose did not spell out.
 *
 * A post's `refs` is a **placed array**, so every entry in it is an atom, and
 * an atom has two skins. This row is read-only ink — nothing here can be
 * selected, deleted or dragged where it sits — so it wears the read-only
 * skin, {@link TugAtomRef}: glyph plus a name, no box. The box is the
 * *editable* skin's and means "manipulable in place", which is why the same
 * value still arrives boxed in a composer. The row was never the defect; the
 * prose beside it was, for looking like nothing. See
 * `tuglaws/entity-presentation.md`.
 *
 * The skin renders **presentationally** here: the wrapper span below already
 * carries the full annotation contract and the pending/unresolvable tooltip
 * states, so a skin that also stamped its own would duplicate the contract
 * and nest a mark inside a mark. The affordance still arrives for free —
 * `tug-atom-ref.css` keys cursor and hover off an annotated wrapper, and
 * {@link annotationProps} stamps one only for an `actionable` resolution, so
 * a pending or unresolvable ref renders inert with its reason on the tooltip
 * and no prop had to be threaded to say so.
 *
 * A session — not a file-shaped thing at all — renders as the live
 * {@link TugSessionCitation}, exactly as a session atom does in a transcript
 * body: the dot is information no other form carries.
 */
function RefAtom({
  chipRef,
  root,
}: {
  chipRef: OverviewRef;
  root: OverviewRefRoot | null;
}): React.ReactElement {
  // A session ref is a CITATION, and it renders as one: the session atom, the
  // callsign, the same chip every foreign surface shows. The chip owns the
  // whole gesture, including whether to offer it.
  if (chipRef.kind === "session") {
    return <TugSessionCitation citedId={chipRef.target} />;
  }
  // A dash ref branches BEFORE resolution, because a dash name is not a path
  // and must never be resolved as one: `resolveOverviewRef` would look it up
  // in the repo, come back unresolvable, and render the chip inert with a
  // not-found tip — the promised click dead, and the reason for it wrong.
  if (chipRef.kind === "dash") {
    return (
      <TugTooltip
        variant="entity"
        align="start"
        content={dashTip({ name: chipRef.target })}
      >
        <span
          // The Arcs rail is where an arc's join is already offered, so the click
          // reveals it rather than inventing a second landing surface.
          onClick={() => {
            dispatchCommand("reveal-arcs");
          }}
          // Same contract the file skin's own marks carry: revealing the rail
          // activates the target pane, and this chip must not also activate
          // the pane it sits in.
          data-no-activate=""
          data-tug-focus="refuse"
        >
          <TugAtomRef entity={{ kind: "dash", name: chipRef.target }} />
        </span>
      </TugTooltip>
    );
  }
  const resolution = resolveOverviewRef(chipRef, root);
  const isDir =
    resolution.state === "actionable" &&
    resolution.payload.kind === "directory";
  // The label is the skin's own: a basename for a file, `commit:<8>` for a
  // commit. An atom stands with no sentence around it, so a bare hash names
  // nothing a reader can use and the word belongs in the label — which is
  // also the spelling copy already uses, so selection and menu agree.
  const skin = (
    <TugAtomRef
      entity={
        chipRef.kind === "commit"
          ? { kind: "commit", sha: chipRef.target }
          : { kind: "file", path: chipRef.target, annotate: false }
      }
      // The glyph families are the atom vocabulary's own: a commit is a point
      // on a line, a folder a folder, everything else a file.
      icon={isDir ? <Folder /> : undefined}
    />
  );
  const marked = (
    // No `data-tugx-wrapped` — that mark is for a run the annotator split
    // out of prose, whose affordance has to be painted onto the text. An atom
    // has its own shape and its own hover, exactly as in a transcript body.
    <span {...annotationProps(chipRef, resolution)}>{skin}</span>
  );
  // Every ref describes itself in the app's own bubble, not the OS's —
  // whichever kind it is and whichever state its lookup is in.
  const tip = refTip(chipRef, resolution);
  return (
    <TugTooltip variant={tip.variant} align="start" content={tip.content}>
      {marked}
    </TugTooltip>
  );
}

/**
 * The annotator's inputs for one post, bound to that post's OWN repository.
 *
 * The Session transcript's {@link useAnnotationContext} reads its project
 * from the card's session binding, which the Overview has none of: the card
 * is app-wide and each post narrates a different session. So the root is the
 * post's, acquired from its `projectDir`, and every post gets a context
 * pointing at the repo its prose was written about — which is what lets a
 * post from a closed session, read days later, still resolve.
 *
 * No command catalog: with no live session there is no authoritative list,
 * and an unconfirmable command stays plain text, which is the right answer
 * rather than a missing one.
 */
function useOverviewAnnotation(root: OverviewRefRoot | null): AnnotationContext {
  const projectDir = root?.projectDir ?? null;
  const workspaceKey = root?.workspaceKey ?? null;
  const names = fileNameResolverFor(projectDir, workspaceKey);
  const commits = commitResolverFor(projectDir, workspaceKey);
  const resolvePath = useMemo(
    () =>
      makeReferenceResolver({
        paths: pathResolutionStore,
        names,
        // Relative paths in the prose are relative to the narrated session's
        // project, the same root its refs were spelled under.
        cwd: projectDir,
      }),
    [names, projectDir],
  );
  const resolveCommit = useMemo(
    () => (sha: string) => commits?.lookup(sha) ?? NO_COMMIT_VERDICT,
    [commits],
  );
  const subscribe = useMemo(() => {
    // The citation store joins the batcher unconditionally: it is a singleton
    // with no per-project identity, and a session verdict arriving is exactly
    // as much a reason to re-mark as a path verdict is. Without it here, a
    // session run reserved on the first pass would stay reserved — the mark
    // waits on a batch that never comes.
    const sources = [
      pathResolutionStore,
      sessionCitationStore,
      names,
      commits,
    ].filter((source): source is NonNullable<typeof source> => source !== null);
    return new VerdictBatcher(sources).subscribe;
  }, [names, commits]);
  return useMemo(
    () => ({
      isKnownSlashCommand: () => false,
      resolvePath,
      resolveCommit,
      // The Overview is where sessions are named in prose — a post's whole
      // subject is which session did what — so it scans for them.
      resolveSession: resolveSessionRef,
      commitRoot: projectDir,
      subscribe,
    }),
    // `resolveSessionRef` is a module function, not a closure over anything
    // here — the citation store is a singleton keyed by callsign, and a
    // session's identity is app-wide rather than per-post.
    [resolvePath, resolveCommit, projectDir, subscribe],
  );
}

/**
 * A post body, rendered as markdown and annotated by the app's own content
 * annotator.
 *
 * The body is markdown — the Session transcript's markdown, through the
 * transcript's own primitive ({@link TugMarkdownBlock} in static
 * `initialText` mode): the same pulldown-cmark parse, the same DOMPurify
 * sanitize, the same enhancer chain. So a backticked name is a code span
 * rather than three literal characters, a bare URL is an anchor, and a
 * fence is a fence.
 *
 * The annotation comes with it. `renderIncremental`'s enhancer chain runs
 * `annotateContent` over every block it builds, so paths and shas are found
 * by scanning the prose and marked where each resolver confirms them: a file
 * that stats, a commit git can show. A mention is clickable because it is IN
 * the sentence, not because the model also listed it — the difference from
 * the bespoke matcher this replaced, which could only ever find targets the
 * ref list already named. Inline `<code>` gets the same treatment through
 * `classifyInlineCode`, which is what makes a backticked path clickable by
 * being backticked.
 *
 * The block reads its {@link AnnotationContext} off the {@link AnnotationScope}
 * the row already mounts — no prop to thread. Static mode is correct: a post
 * never changes after it is written, and the pending→answer swap is a React
 * key change ([L26]) that remounts the block outright.
 *
 * Nothing here places anything: the marks land in the prose where the prose
 * put them. The click and the context menu are serviced by the transcript
 * root's delegated listener, reading the same dataset every annotated
 * element in the app carries.
 */
function OverviewPostBody({
  post,
  bodyRef,
}: {
  post: OverviewPostEntry;
  bodyRef?: React.MutableRefObject<HTMLElement | null>;
}): React.ReactElement {
  // A session named in the prose becomes the live citation chip, and a
  // confirmed sha gets the app's own commit hover — both portaled into the
  // runs the annotator marked. Driven by the block's own `onAnnotated`, so
  // collection cannot run before the pass that creates the spans ([P06]).
  const { onAnnotated, portals } = useAnnotationPortals();
  return (
    <div
      className="overview-post-body"
      ref={(el) => {
        if (bodyRef !== undefined) bodyRef.current = el;
      }}
    >
      <TugMarkdownBlock
        key={post.key}
        initialText={post.body}
        onAnnotated={onAnnotated}
      />
      {portals}
      <OverviewPostAttachments post={post} />
    </div>
  );
}

/**
 * The pictures a question was asked with, under its prose — the Session
 * transcript's own attachment strip, on this channel's posts.
 *
 * It IS that component ({@link TugAttachmentPreview}), not a second one that
 * looks like it: the same tiles, the same `image-N` captions, the same
 * click-to-enlarge sheet with ←/→ paging and Copy. Two things differ, and both
 * are declarations rather than a second implementation.
 *
 * Where the bytes come from: a session card's attachment lives in that card's
 * in-memory bytes store from the moment it was dropped; a Overview post is
 * history, read back days later, so its bytes rest on disk and are fetched
 * from there ({@link hydrateOverviewAttachments}) into the channel's own store,
 * keyed by the path itself.
 *
 * And how much room the surface has: `compact`, because this is a rail. A tile
 * sized for a card's measure is most of this column's width, and the
 * comfortable sheet opens wall-to-wall on it.
 *
 * Read-only, so no `deletable`: a picture already in the channel is as final
 * as the sentence beside it.
 *
 * The fetch is asked for in a layout effect rather than during the render that
 * needs it ([L03]) — the strip is already subscribed to the store, so a tile
 * with no pixels yet is a reserved slot that fills in when the read lands.
 */
function OverviewPostAttachments({
  post,
}: {
  post: OverviewPostEntry;
}): React.ReactElement | null {
  const bytesStore = overviewAttachmentBytesStore();
  const attachments = post.attachments;
  useLayoutEffect(() => {
    hydrateOverviewAttachments(attachments);
  }, [attachments]);
  // The path is the atom id — it is what the bytes are keyed by, and it is
  // stable for the life of the post. The caption is the same contiguous
  // `image-N` the composer's own strip shows, so a picture is called the same
  // thing while it is being sent and after it has been.
  const atoms = useMemo<AtomSegment[]>(
    () =>
      attachments.map((attachment, i) => ({
        kind: "atom",
        type: "image",
        label: `image-${i + 1}`,
        value: `image-${i + 1}`,
        id: attachment.path,
      })),
    [attachments],
  );
  if (atoms.length === 0) return null;
  return (
    <TugAttachmentPreview
      atoms={atoms}
      bytesStore={bytesStore}
      density="compact"
      className="overview-post-attachments"
      data-testid="overview-post-attachments"
    />
  );
}

/**
 * The Overview's Z1B — the end-state row under a post's body, built from the
 * Session card's own parts at the Session card's own sizes: the `OK` badge
 * (`endStateBadgeFor`, so the word and the role are the transcript's, not a
 * second vocabulary), the `•` separators, an elapsed reading where there is
 * one, and the text+icon COPY.
 *
 * A post is `complete` by construction — it exists because it was written, so
 * there is no interrupted or errored post to report.
 *
 * Elapsed is reported for the Operator alone. The Operator's post is an ANSWER
 * — the reader asked for it and waited on it, so how long it took is part of
 * what happened. A Observer post was never waited on: it arrives unbidden, and
 * its clock is the writing machinery's, not the reader's, so a duration on it
 * is a number about nobody. This is not the header stamp's rule: every post is
 * stamped, because WHEN a post arrived is a fact about all of them. How long
 * one took to write is a fact about an answer. A user's question was typed
 * rather than run and carries no elapsed at all, so its row reads
 * `[OK] • [COPY]` — exactly as the Session transcript's user half does, and now
 * the Observer's does too.
 */
function OverviewPostZ1B({
  post,
  children,
}: {
  post: OverviewPostEntry;
  children?: React.ReactNode;
}): React.ReactElement {
  const badge = endStateBadgeFor("complete");
  const elapsedMs = post.author === "operator" ? post.elapsedMs : null;
  return (
    <div className="overview-post-z1b" data-slot="overview-post-z1b">
      <TugBadge
        size="md"
        emphasis="ghost"
        role={badge.role}
        icon={<Check size={14} aria-hidden="true" />}
        iconGap={5}
      >
        {badge.text}
      </TugBadge>
      {elapsedMs !== null ? (
        <>
          <TugLabel size="xs" emphasis="calm" aria-hidden>
            •
          </TugLabel>
          <TugLabel size="xs">{formatDurationMs(elapsedMs)}</TugLabel>
        </>
      ) : null}
      <TugLabel
        size="xs"
        emphasis="calm"
        aria-hidden
        className="overview-post-z1b-separator"
      >
        •
      </TugLabel>
      {/* The wrapper is the Session Z1B's: it cancels the button's intrinsic
          padding so COPY sits at the row's own gap from the `•` rather than
          a gap plus a button's worth of air. */}
      <span className="overview-post-z1b-copy">
        <BlockCopyButton
          size="xs"
          getText={() => post.body}
          aria-label="Copy post"
          data-slot="overview-post-copy"
        />
      </span>
      {children}
    </div>
  );
}

/**
 * The workspace roots the visible posts resolve their refs under, plus the
 * re-render tick their verdicts arrive on.
 *
 * Each distinct `projectDir` gets a browse hold ({@link acquireWorkspace} —
 * refcount-free, cached for the app's life, the Open Quickly shape), and the
 * returned lookup answers with the acquired `{workspaceKey, projectDir}`
 * pair once the hold lands. [L02]: readiness and every resolver verdict
 * enter React through one `useSyncExternalStore` whose snapshot is the sum
 * of the stores' monotonic versions — a probe's answer bumps a version,
 * the sum moves, the waiting atoms re-render.
 */
function useOverviewRefRoots(
  posts: readonly OverviewPostEntry[],
): (projectDir: string | null) => OverviewRefRoot | null {
  const dirs = useMemo(() => {
    const set = new Set<string>();
    for (const post of posts) {
      // Every rooted post, refs or not: the annotator needs the root for
      // PROSE mentions — a user question's typed path, an answer whose ref
      // list happens to be empty — and gating on refs left those posts'
      // paths unresolvable, rendering as dead text.
      if (post.projectDir !== null) {
        set.add(post.projectDir);
      }
    }
    return Array.from(set).sort();
  }, [posts]);
  const dirsKey = dirs.join("\n");

  // [L03] — holds must be requested before the lookups that wait on them.
  useLayoutEffect(() => {
    for (const dir of dirs) acquireWorkspace(dir);
    // dirsKey IS dirs, serialized for dependency identity.
  }, [dirsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Which dirs have landed matters to the subscription itself: a workspace
  // arriving mints that project's resolvers, and the subscription has to
  // reach them — so readiness re-keys the subscribe and the store swap
  // resubscribes.
  const readyKey = dirs.filter((dir) => getWorkspace(dir) !== null).join("\n");
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      const unsubs = [
        subscribeWorkspaces(listener),
        pathResolutionStore.subscribe(listener),
      ];
      for (const dir of dirs) {
        const ws = getWorkspace(dir);
        if (ws === null) continue;
        const names = fileNameResolverFor(ws.projectDir, ws.workspaceKey);
        if (names !== null) unsubs.push(names.subscribe(listener));
        const commits = commitResolverFor(ws.projectDir, ws.workspaceKey);
        if (commits !== null) unsubs.push(commits.subscribe(listener));
      }
      return () => {
        for (const unsub of unsubs) unsub();
      };
    },
    // Both keys are the arrays they serialize, which is the point: identity
    // for the hook, content for the closure.
    [dirsKey, readyKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const getSnapshot = useCallback((): number => {
    let sum = pathResolutionStore.version();
    for (const dir of dirs) {
      const ws = getWorkspace(dir);
      if (ws === null) continue;
      sum += 1;
      sum +=
        fileNameResolverFor(ws.projectDir, ws.workspaceKey)?.version() ?? 0;
      sum += commitResolverFor(ws.projectDir, ws.workspaceKey)?.version() ?? 0;
    }
    return sum;
  }, [dirsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useSyncExternalStore(subscribe, getSnapshot);

  return useCallback(
    (projectDir: string | null): OverviewRefRoot | null => {
      if (projectDir === null) return null;
      const ws = getWorkspace(projectDir);
      return ws === null
        ? null
        : { projectDir: ws.projectDir, workspaceKey: ws.workspaceKey };
    },
    [readyKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

function OverviewPostRow({
  post,
  root,
  formats,
}: {
  post: OverviewPostEntry;
  root: OverviewRefRoot | null;
  formats: ReturnType<typeof useTimeFormats>;
}): React.ReactElement {
  const at = new Date(post.atMs);
  const authorLabel = AUTHOR_LABEL[post.author];
  // Per-row ⌘C / right-click Copy — the same cell wiring the Session
  // transcript's rows use, resolver included. A selection across rendered
  // bold or code has to come back as the markdown that produced it, which
  // means reconstructing it from the DOM: `selectionToTranscriptMarkdown`
  // is the transcript's own walk, and the hook writes both clipboard
  // flavors off it ([P03]/[P05] in `transcript-host-helpers.ts`).
  const resolveCopyMarkdown = useCallback<CopyMarkdownResolver>(
    (bodyEl, selection) => selectionToTranscriptSubstrate(selection, bodyEl),
    [],
  );
  const { ResponderScope, cellProps, bodyRef, menu } = useTranscriptCellMenu({
    resolveCopyMarkdown,
  });
  // The wake reason explains why this post exists at all — background to the
  // sentence, so it rides the identifier's tooltip rather than the row.
  const identifierTitle =
    post.wakeReason !== null
      ? `${authorLabel} — ${post.wakeReason}`
      : undefined;
  const annotation = useOverviewAnnotation(root);
  // A ref the prose already names is already clickable where the reader is
  // reading — the annotator marked it in the sentence — so a chip for it
  // would be the same thing twice. What is left is provenance the sentence
  // never got to.
  //
  // The narrated session leads that list. It is the first thing the post
  // rests on, and this strip is where the things a post rests on are named —
  // so it is a ref here like any other, rendered by the same `RefAtom` that
  // draws a cited session anywhere else. It used to ride the header instead,
  // beside the clock, which is a single flex line shared with a chip of no
  // fixed width: whatever the atom could not give up, the clock paid for by
  // breaking "7:10:22 PM" across two lines. Truncating the atom harder only
  // moved the loss around. Here the row is the atom's own and wraps, so the
  // atom fits whatever it says, and the header holds nothing that varies.
  const chipRefs = useMemo(() => {
    const rest = unmentionedRefs(post.body, post.refs).filter(
      (r) => !(r.kind === "session" && r.target === post.sessionId),
    );
    return post.sessionId === null
      ? rest
      : [{ kind: "session" as const, target: post.sessionId }, ...rest];
  }, [post]);
  return (
    <ResponderScope>
      {/* Per POST, not per card: the Overview is app-wide and each post
          narrates a different session, so the root a copy carries is the one
          that post's prose was written against — the same root its own
          annotator resolves paths with. `closest()` takes the nearest stamp,
          so this wins for its own subtree without anyone coordinating. */}
      <div
        className="overview-cell"
        data-author={post.author}
        {...clipboardOriginProps(root?.projectDir ?? null)}
        {...cellProps}
      >
        <AnnotationScope value={annotation}>
          <TugTranscriptEntry
            className="overview-post"
            participant={AUTHOR_PARTICIPANT[post.author]}
            identifier={<span title={identifierTitle}>{authorLabel}</span>}
            timestamp={
              // Every voice is stamped, the Observer included. A post's place
              // in the column says what came before it; the clock says WHEN,
              // which is the question a rail of narration is most often asked
              // — "was that just now, or this morning?" — and the sequence
              // cannot answer it. The elapsed reading in the Z1B is a
              // different fact and stays the Operator's alone.
              <time dateTime={at.toISOString()} title={formats.full.format(at)}>
                {formats.short(at)}
              </time>
            }
            body={<OverviewPostBody post={post} bodyRef={bodyRef} />}
            controls={
              <>
                {chipRefs.length > 0 ? (
                  // Its OWN row, and ABOVE the Z1B: these atoms are the end of
                  // the CONTENT — the rest of what the post rests on, which the
                  // prose ran out of room to name — and the Z1B is the row's
                  // footer, under everything the post says. Below the footer
                  // they read as debris after the end; above it they read as
                  // the last thing the post tells you.
                  //
                  // A row of their own for the reason they are not in the Z1B's
                  // flex: sharing it queued the atoms after OK / elapsed / COPY
                  // and wrapped them wherever the width ran out, so where a chip
                  // landed said nothing about what it was.
                  <div className="overview-post-refs">
                    {chipRefs.map((r) => (
                      <RefAtom
                        key={`${r.kind}:${r.target}`}
                        chipRef={r}
                        root={root}
                      />
                    ))}
                  </div>
                ) : null}
                <OverviewPostZ1B post={post} />
              </>
            }
          />
        </AnnotationScope>
        {menu}
      </div>
    </ResponderScope>
  );
}

/**
 * The Overview card's content ([L25]: the pane owns geometry and chrome; this
 * owns the surface inside it).
 */
export function OverviewContent({
  cardId,
}: OverviewContentProps): React.ReactElement {
  const { posts, status, pendingRequestId } = useOverview();
  const formats = useTimeFormats();
  const rootFor = useOverviewRefRoots(posts);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the reader is at the bottom, sampled BEFORE the new post is laid
  // out — reading it afterwards would always say "no", since the arriving row
  // is exactly what pushed the bottom away.
  //
  // POSITION, not intent. The Session transcript's `SmartScroll` follows a
  // reader's INTENT: a wheel-up disengages the moment it happens, wherever it
  // lands, and only a gesture that ends at the bottom re-engages. This column
  // asks the simpler question — "is the live edge under the eye right now" —
  // because a rail has no gesture vocabulary to disambiguate and no restore
  // target to defend. The two models agree everywhere except the flick that
  // starts and ends inside the slack, which here does not disengage. That is
  // the whole of the difference and it is deliberate; anything more is
  // `SmartScroll`, which belongs to the list view it drives.
  const followingRef = useRef(true);
  // The affordance that follow-state drives: shown exactly when the reader is
  // NOT at the live edge. Held as a DOM ref because the state it reflects is
  // appearance, not data ([L06]) — see `setFollowing`.
  const jumpButtonRef = useRef<HTMLButtonElement | null>(null);
  // The transcript's height as of the PREVIOUS committed render, and the key
  // of the post that led it. Written at the end of every layout pass, read at
  // the top of the next: together they say "older rows were prepended, and
  // this much taller", which is exactly what the scroll compensation needs.
  // Deliberately not written from the scroll handler — a prepend fires no
  // scroll event, so a ref written there would hold whatever the last human
  // scroll saw. It IS written from the resize observer below, because a row
  // that grows after its layout pass moves the same height the compensation
  // measures against; leaving it stale there would have the next prepend
  // count that growth a second time.
  const prevScrollHeightRef = useRef(0);
  const prevFirstKeyRef = useRef<string | null>(null);
  // The `scrollTop` this card last WROTE while pinning to the live edge, so a
  // scroll event can be read for whose act it was. Every pin goes through
  // `pinToBottom`, which is the only place this moves. Infinite until the
  // first pin: before this card has written a position, no scroll event can
  // be this card's, and one that arrives (the cold-boot restore's) must be
  // free to say the reader is not at the bottom.
  const pinTopRef = useRef(Number.POSITIVE_INFINITY);

  /**
   * The one writer of follow-state. Every place that decides the reader is or
   * is not at the live edge goes through here, so the intent and the
   * affordance can never disagree — the button's `data-visible` is written in
   * the same statement that moves the ref, straight onto the DOM node ([L06]).
   *
   * The scroller's `data-tug-scroll-state` moves in the same statement, for
   * the same reason one step out: `captureRegionScrolls` reads that attribute
   * at every save moment, and `{atBottom: true}` is what tells the restore
   * path to re-pin to the LIVE edge rather than replay the saved pixel. A
   * column that was following when the bag was taken has grown by the time the
   * bag comes back, so the saved pixel names a place in the middle of it.
   */
  const setFollowing = useCallback((next: boolean): void => {
    followingRef.current = next;
    const btn = jumpButtonRef.current;
    if (btn !== null) btn.dataset.visible = String(!next);
    const el = scrollRef.current;
    if (el === null) return;
    // Omitted rather than written false when the reader is up in history:
    // absent meta is exactly the raw-pixel restore, which is the right
    // restore for a position the reader chose.
    if (next) el.dataset.tugScrollState = JSON.stringify({ atBottom: true });
    else delete el.dataset.tugScrollState;
  }, []);

  /**
   * Pin to the live edge, and remember where that put us.
   *
   * Every write of `scrollTop` that means "follow the newest post" goes
   * through here, because `onScroll` has to be able to tell this card's own
   * write apart from the reader's gesture — see the handler.
   */
  const pinToBottom = useCallback((el: HTMLDivElement): void => {
    el.scrollTop = el.scrollHeight;
    pinTopRef.current = el.scrollTop;
  }, []);

  /** Is the live edge under the eye? The one geometric reading, spelled once. */
  const atBottom = useCallback(
    (el: HTMLDivElement): boolean =>
      el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX,
    [],
  );

  // Height changes that no render tells us about.
  //
  // The pin below runs on the posts array, which is the ONLY thing a
  // render-driven effect can see — and a transcript's height moves for
  // reasons that are not a new post. A post's markdown settles a beat after
  // it mounts; an annotator verdict lands and a ref becomes an atom; the
  // narrated session's citation resolves and a chip appears in a header
  // (`at0368` watches exactly that arrive); the composer grows a row under
  // the user's typing and takes that row out of this track; the allocator
  // widens the rail and every paragraph rewraps. Each of those moves the live
  // edge away from a reader who is following it, with no render to notice —
  // so the observer notices instead, and re-pins on the real geometry.
  //
  // It is also where follow-state is RE-ENGAGED, which is the half a pin
  // alone cannot do: geometry moves in both directions, and a change that
  // brings the edge back under a reader who had left it must be read as
  // arriving at the bottom. See the observer body.
  //
  // The scroller is observed for its own box (the viewport) and every cell
  // for theirs (the content), which together are every way this column's
  // scroll height can change. [L03] — live before the first post can settle.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) {
        pinToBottom(el);
      } else {
        // The other direction, and the one a resize is the only cause of: a
        // geometry change can put the live edge back under the eye without
        // any scroll event to say so. The rail animates from Stack to Split
        // and the column gets taller than its content; a pane drag does the
        // same; a collapsing row shortens the content under a reader who was
        // above it, and the browser clamps `scrollTop` silently. In each of
        // those the reader ends up AT the bottom while this card still
        // believes they are away from it — so the button hovers over the
        // newest post offering to take them where they already are, and the
        // next post does not follow. Re-read the geometry instead of
        // remembering it — and where the read says the edge is back under the
        // eye, close the slack the same way the following branch does, so
        // "following" always means resting ON the edge rather than within
        // 24px of it.
        const back = atBottom(el);
        setFollowing(back);
        if (back) pinToBottom(el);
      }
      prevScrollHeightRef.current = el.scrollHeight;
    });
    observer.observe(el);
    // The cells are re-observed as the column changes, from the same effect
    // that owns the observer — one place that decides what is watched.
    const sync = (): void => {
      for (const cell of el.querySelectorAll<HTMLElement>(
        ":scope > .overview-cell",
      )) {
        observer.observe(cell);
      }
    };
    sync();
    const mutations = new MutationObserver(sync);
    mutations.observe(el, { childList: true });
    return () => {
      mutations.disconnect();
      observer.disconnect();
    };
  }, [setFollowing, atBottom]);

  // Cold-boot restore, the half `captureRegionScrolls` cannot do alone.
  //
  // `CardHost` saves this scroller by key and replays the saved `scrollTop`
  // on every path that rebuilds the card — Maker ▸ Reload, a cross-pane move,
  // an HMR remount — and it RETRIES that write on every subtree mutation
  // until the position sticks. For a column that was resting on the live edge
  // the saved pixel is the bottom AS IT WAS: the Overview keeps growing while
  // the bag sits, so replaying it lands the reader in the middle of history
  // with the jump button up, and the retry loop re-lands them there each time
  // a post arrives. That is the same trap `TugListView` documents, and this
  // takes the same way out — the at-bottom case is claimed here and answered
  // by re-pinning to the edge that exists now.
  //
  // Only that case. A reader parked in history saves no `atBottom` meta, and
  // the un-preventDefaulted event falls through to the host's raw write,
  // which is the correct restore for a position the reader chose. [L03] — the
  // listener must be live before the first restore beat, which arrives in the
  // same commit as the mount.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    // Publish the state the card is CONSTRUCTED in. `followingRef` starts
    // true, and a column that is never scrolled would otherwise be saved with
    // no meta at all — the one case this whole path exists for.
    setFollowing(followingRef.current);
    const onRegionScrollSet = (event: Event): void => {
      const meta = (event as CustomEvent<{ meta?: unknown }>).detail.meta;
      const savedAtBottom =
        typeof meta === "object" &&
        meta !== null &&
        (meta as { atBottom?: unknown }).atBottom === true;
      if (!savedAtBottom) return;
      event.preventDefault();
      setFollowing(true);
      pinToBottom(el);
    };
    el.addEventListener("tug-region-scroll-set", onRegionScrollSet);
    return () => {
      el.removeEventListener("tug-region-scroll-set", onRegionScrollSet);
    };
  }, [setFollowing, pinToBottom]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const firstKey = posts.length > 0 ? posts[0]!.key : null;
    const prepended =
      prevFirstKeyRef.current !== null &&
      firstKey !== null &&
      firstKey !== prevFirstKeyRef.current;
    if (followingRef.current) {
      // [L06]: following the newest post is a scroll write, not React state.
      pinToBottom(el);
    } else if (prepended) {
      // Older history arrived above the reader. Push the viewport down by
      // exactly what was inserted, so the line being read stays under the
      // eye. Guarded on `followingRef` because the follow effect above owns
      // `scrollTop` in the other case, and one property cannot have two
      // owners — in practice a reader up in history is never following, so
      // the guard states that invariant rather than adding a condition.
      el.scrollTop += el.scrollHeight - prevScrollHeightRef.current;
    }
    prevScrollHeightRef.current = el.scrollHeight;
    prevFirstKeyRef.current = firstKey;
    // `pendingRequestId` is a dependency because the in-flight wave is a ROW:
    // it mounts under the last post and pushes the live edge down exactly as
    // an arriving post does. Without it the placeholder for the answer the
    // reader just asked for could appear below the fold.
  }, [posts, pendingRequestId, pinToBottom]);

  // Annotation gestures — the Session transcript's own delegated layer,
  // `useAnnotationClicks`, mounted over the Overview's scroller. The atoms
  // here are FULLY stamped (payload dataset, not just a kind), so the layer
  // reads a real payload back off whatever element the press lands on. No
  // codeSessionStore in the context: the Overview has no live session, and a
  // kind that needs one declines on its own. `activateCard` is a no-op — the
  // opened card claims activation itself; the rail stays put.
  useAnnotationClicks(scrollRef, { activateCard: () => {} });

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    // A scroll EVENT is not a scroll GESTURE. Pinning writes `scrollTop`, and
    // the event that write queues is delivered on a later frame, against
    // whatever the column has become in the meantime — one post taller, one
    // settled paragraph taller — so the position it carries reads as "away
    // from the bottom" when nobody moved anything. Reading that back as the
    // reader leaving is how a following column silently stopped following,
    // permanently: the re-engage branch of the resize observer only fires on
    // a geometry change that brings the edge back, and growth never does.
    //
    // So only a scroll that went UP from where this card last pinned can
    // disengage. Content growing under a pin leaves `scrollTop` exactly where
    // the pin put it — the pin is the reference, not the bottom, and the
    // bottom has already moved. A reader's wheel-up is below it by however
    // far they scrolled, which is the one thing that means they left.
    if (!followingRef.current || el.scrollTop < pinTopRef.current) {
      setFollowing(atBottom(el));
    }
    // Near the top, ask for the page before this one. The store owns every
    // guard — nothing to ask for, nothing to anchor on, a request already
    // out — because this fires many times per scroll gesture.
    if (el.scrollTop < LOAD_OLDER_PX) getOverviewStore()?.loadOlder();
  };

  /**
   * The affordance's own gesture: back to the live edge, and following again.
   *
   * `setFollowing` FIRST, so the write below is already the act of a
   * following column rather than a jump that the next arriving post has to
   * re-decide. The scroll then fires `onScroll`, which reads the landing
   * position and confirms it — a jump that somehow lands short corrects
   * itself rather than leaving the button hidden over a column that is not at
   * its edge.
   */
  const jumpToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    setFollowing(true);
    pinToBottom(el);
  }, [setFollowing, pinToBottom]);

  /**
   * Step the column one POST — the Session transcript's ⌥⌘↑ / ⌥⌘↓, read here.
   *
   * The selection is the transcript's own
   * ({@link computePageNavigation}): the entry currently flush at the top is
   * the current one, down advances to the next and pins its top flush, up
   * snaps a mid-entry view back to the current entry's top before stepping
   * past it, and a down press already on the last entry means the live
   * bottom. Sharing that function is the point — a second rule for what "the
   * next post" means would be a second navigation model on one gesture.
   *
   * The geometry is read from real rects rather than any height sum, for the
   * reason the list view reads them: the column's `row-gap` and the first
   * row's margin belong to no cell's box, so a sum drifts by a gap per post.
   *
   * The scroll is a plain `scrollTop` write ([L06]) — the Overview's column is
   * an ordinary scroller, not a `SmartScroll`-driven list view — and the
   * follow-bottom intent is this card's follow-state, set through its one
   * writer so the affordance and the saved scroll-state move with it. The
   * press states its intent rather than leaving `onScroll` to infer it from
   * where the write happened to land.
   */
  const pageByPost = useCallback((direction: "up" | "down"): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const cells = Array.from(
      el.querySelectorAll<HTMLElement>(":scope > .overview-cell"),
    );
    const portTop = el.getBoundingClientRect().top;
    const result = computePageNavigation({
      direction,
      cellTops: cells.map((cell) => cell.getBoundingClientRect().top - portTop),
    });
    if (result.kind === "none") return;
    if (result.kind === "bottom") {
      setFollowing(true);
      pinToBottom(el);
      return;
    }
    const target = cells[result.index];
    if (target === undefined) return;
    setFollowing(false);
    el.scrollTop += target.getBoundingClientRect().top - portTop;
  }, [setFollowing, pinToBottom]);

  // ⌥⌘↑ / ⌥⌘↓ — the Session card's transcript chord, on this card's column.
  //
  // The commands are `PREVIOUS_TURN` / `NEXT_TURN` from the registry, routed
  // `key-card`: the chord is delivered to whichever card the user is in, and a
  // card answers it by registering a handler on its `card-content` responder.
  // So this is the whole wiring — no second binding, no chord of its own, and
  // it works from anywhere focus sits in the rail, the composer included.
  //
  // Their menu items are the Session menu's and validate on a session card
  // being frontmost, so with the Overview frontmost those rows dim. That is
  // exactly what `disabledChord: "detach"` is for: the dimmed item releases
  // the key equivalent, the chord reaches the web view, and the key card —
  // this one — is asked. The registry's own comment calls that the shadowable
  // case; this card is a shadow.
  const {
    ResponderScope: CardContentResponderScope,
    responderRef: cardContentResponderRef,
  } = useResponder({
    id: `${cardId}-card-content`,
    kind: "card-content",
    actions: {
      [TUG_ACTIONS.PREVIOUS_TURN]: () => {
        pageByPost("up");
      },
      [TUG_ACTIONS.NEXT_TURN]: () => {
        pageByPost("down");
      },
    },
  });

  return (
    <CardContentResponderScope>
      <div
        ref={cardContentResponderRef as (el: HTMLDivElement | null) => void}
        className="overview-card"
        data-slot="overview-card"
        data-testid="overview-card"
        data-overview-card-id={cardId}
        // Focusable root so `transferFocusForActivation` → `applyBagFocus` has a
        // target to land the ring on when the card is focused.
        tabIndex={-1}
      >
        {/* The transcript's REGION, not the scroller: the jump affordance
            floats over the column, so it needs a positioned ancestor that
            does not scroll with what it floats over. The session card's
            `.tug-control-bar-region` plays the same part for the same
            reason. */}
        <div className="overview-transcript-region">
          <div
            className="overview-transcript"
            data-testid="overview-transcript"
            data-tug-scroll-key="overview-transcript"
            ref={scrollRef}
            onScroll={onScroll}
          >
            {posts.length === 0 ? (
              <div className="overview-empty" role="status">
                {status === "ready" ? "Nothing reported yet." : "Loading…"}
              </div>
            ) : (
              posts.map((post) => (
                <OverviewPostRow
                  key={post.key}
                  post={post}
                  root={rootFor(post.projectDir)}
                  formats={formats}
                />
              ))
            )}
            {pendingRequestId !== null ? (
              // [L26]: keyed exactly as the answer will be, so the placeholder
              // becomes the answer in place rather than being torn down and a new
              // row built where it stood.
              <div
                key={`req:operator:${pendingRequestId}`}
                className="overview-cell"
                data-author="operator"
                data-pending=""
                data-testid="overview-pending-row"
              >
                <TugTranscriptEntry
                  className="overview-post"
                  participant="operator"
                  identifier={AUTHOR_LABEL.operator}
                  // The transcript's in-flight wave, not a sentence: "working" is
                  // said in the Session card's language, the same three bars its
                  // own Z1C paints while a turn runs.
                  body={
                    <div className="overview-post-pending">
                      <TugProgressIndicator
                        variant="wave"
                        state="running"
                        role="inherit"
                        aria-label="Working…"
                        aria-live="polite"
                        data-testid="overview-pending-wave"
                      />
                    </div>
                  }
                />
              </div>
            ) : null}
          </div>
          {/* Mounted unconditionally ([L26]) — the show / hide is the CSS fade
            on `data-visible`, which `setFollowing` writes. Mounting it behind
            the condition would make every arrival at and departure from the
            live edge a React reconciliation. */}
          <TugJumpToBottomButton ref={jumpButtonRef} onClick={jumpToBottom} />
        </div>
        <div
          className="overview-composer-slot"
          data-testid="overview-composer-slot"
        >
          <OverviewComposer pending={pendingRequestId !== null} />
        </div>
      </div>
    </CardContentResponderScope>
  );
}

/**
 * `@` file completion for the composer, against the bootstrap workspace: the
 * Overview is app-wide, so it has no per-card project binding; an unrooted
 * FILETREE query falls through to tugcast's bootstrap workspace, which is the
 * right default for a channel that narrates the whole app. Lazy singleton —
 * one feed subscription however many times the card mounts.
 */
let _fileCompletionProvider: CompletionProvider | null = null;
function overviewFileCompletionProvider(): CompletionProvider {
  if (_fileCompletionProvider !== null) return _fileCompletionProvider;
  const conn = getConnection();
  if (conn === null) return ((_q: string) => []) as CompletionProvider;
  const feedStore = new FeedStore(conn, [FeedId.FILETREE]);
  _fileCompletionProvider = new FileTreeStore(
    feedStore,
    FeedId.FILETREE,
  ).getFileCompletionProvider();
  return _fileCompletionProvider;
}

/**
 * The card's editor settings — the user's font, size, and Return policy, read
 * from the same tugbank domain every Session card's composer reads. A lazy
 * singleton for the reason the completion provider is one: the card is
 * app-wide and single-instance, and one store means one tugbank subscription
 * however many times the card mounts.
 */
let _editorStore: EditorSettingsStore | null = null;
function overviewEditorStore(): EditorSettingsStore {
  _editorStore ??= new EditorSettingsStore();
  return _editorStore;
}

/**
 * The composer's own image bytes — what a drop or a paste lands in, between
 * the moment it is composed and the moment the question is sent.
 *
 * A lazy app-scoped singleton for the reason the completion provider and the
 * editor settings are ones: the card is app-wide and single-instance. It is
 * NOT the transcript's store ({@link overviewAttachmentBytesStore}): these are
 * bytes on their way up, keyed by the atom ids the drop pipeline minted, and
 * those are bytes on their way back down, keyed by the paths tugcast rested
 * them at. Two directions, two keyspaces, and a send hands off from one to
 * the other by clearing its entry.
 */
let _composerBytesStore: AtomBytesStore | null = null;
function overviewComposerBytesStore(): AtomBytesStore {
  _composerBytesStore ??= createAtomBytesStore();
  return _composerBytesStore;
}

/**
 * Ask the Operator something — the session prompt-entry's core editing
 * experience, without its session-bound chrome.
 *
 * The shell is {@link TugEntryShell} (the composer/find-bar structural
 * primitive): the CM6 {@link TugTextEditor} substrate as the input area —
 * which brings the clipboard and undo responders with it ([L11]), plus `@`
 * file-atom completion — and the Z5-style submit button alone in the
 * toolbar's trailing slot. Return does here what the user's editor setting
 * says it does in the Session composer — at the shipped `newline` that means
 * Shift+Return submits, and the button says so by wearing the chord ring
 * ([#chord-ring]): dashed while the promise is conditional, solid for exactly
 * as long as Shift is held alone. Atoms flatten to their values on the wire.
 *
 * **Images are attachments, not text.** Dropping or pasting one lands the
 * substrate's whole image pipeline — the same one the Session composer runs:
 * the file is downsampled, its bytes are staged in the composer's bytes store
 * under a freshly minted atom id, an `image-N` chip lands at the caret, and
 * the {@link TugAttachmentPreview} strip below the field shows the thumbnail
 * with a ✕ on it. That strip is the Session composer's Z4C zone, in this
 * shell's `accessoryRow` slot; the ✕ dispatches `REMOVE_ATTACHMENT` up the
 * chain and this component answers it ([L11]), because it owns the editor
 * document and the bytes. On submit the bytes ride the question up and the
 * post that comes back names the files they came to rest in.
 *
 * A picture with no words is a question — "what is this?" is what the
 * screenshot is for — so the submit gate is the pair, not the text.
 *
 * Emptiness is the `data-empty` DOM bridge on the shell root, written from a
 * substrate update listener and read by CSS to dim the submit — never React
 * state ([L06], the prompt entry's own technique). An attached image counts
 * as not-empty for it: the button must be live for a question that is only a
 * picture.
 *
 * One question at a time: while an answer is outstanding the field is
 * disabled and says so. The store enforces the same rule — this is the
 * affordance, not the guarantee.
 */
function OverviewComposer({
  pending,
}: {
  pending: boolean;
}): React.ReactElement {
  const editorRef = useRef<TugTextEditorDelegate | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  // The user's editor settings — the same store the Session card's composer
  // reads, so Return means here whatever it means there ([L02]).
  const editorStore = overviewEditorStore();
  const editorSettings = useSyncExternalStore(
    editorStore.subscribe,
    editorStore.getSnapshot,
  );
  // Bind the shell for the editor CSS-variable cascade
  // (`--tug-font-family-editor` / `--tug-font-size-editor` / the line
  // metrics). The card has one editor, so the shell is the right root; the
  // composer's own rule then takes a pixel off the bound size.
  useLayoutEffect(() => {
    const el = shellRef.current;
    if (el === null) return;
    editorStore.bind(el, () => {});
    return () => editorStore.unbind();
  }, [editorStore]);

  // The chord that fires the send button when a plain Return does not
  // ([#chord-ring]). `resolveEnterAction` flips the base action on Shift, so
  // at the shipped `newline` setting it is SHIFT+Return that submits — and the
  // shell's default ring says so by painting dashed until Shift is held alone.
  // `undefined` (the `submit` setting) leaves the ring solid, which is then
  // true. Derived, never spelled by hand, so the ring and the key agree.
  const returnAction = editorSettings.returnKeyAction;
  const submitChord = returnAction === "newline" ? "shift" : undefined;

  const bytesStore = overviewComposerBytesStore();
  // The image atoms currently in the document — external state (CodeMirror's
  // atom field) crossing into React so the strip below the field reflects
  // every drop, paste and delete ([L02]: the update listener is the bridge,
  // the strip is a pure projection of what it publishes).
  const [composeImageAtoms, setComposeImageAtoms] = React.useState<
    readonly AtomSegment[]
  >([]);
  // Structural key of that list, so a keystroke does not re-render the strip.
  // A ref because the listener closes over it exactly once — the substrate
  // reads `extensions` at mount and never again.
  const composeAtomsKeyRef = useRef("");

  // The one extension the composer contributes: the `data-empty` bridge and
  // the strip's atom sync, on the same update. They are one listener because
  // they answer the same question — what is in the document now — and
  // emptiness has to account for a picture: a question that is only an image
  // must not dim its own send button.
  const substrateBridge = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        // Numbered by position in the document rather than by the label the
        // atom stored, so the strip reads right the instant one is added or
        // removed — before the chips themselves are renumbered.
        const images = getAtomsInState(update.state)
          .map((p) => p.segment)
          .filter((segment) => segment.type === "image")
          .map((segment, i) => {
            const name = `image-${i + 1}`;
            return segment.label === name && segment.value === name
              ? segment
              : { ...segment, label: name, value: name };
          });
        let key = "";
        for (const atom of images) key += `${atom.id ?? ""}|${atom.label}|`;
        if (key !== composeAtomsKeyRef.current) {
          composeAtomsKeyRef.current = key;
          setComposeImageAtoms(images);
        }
        shellRef.current?.setAttribute(
          "data-empty",
          String(update.state.doc.length === 0 && images.length === 0),
        );
      }),
    [],
  );

  const completionProviders = useMemo<Record<string, CompletionProvider>>(
    () => ({ "@": overviewFileCompletionProvider() }),
    [],
  );

  // An image that could not be attached says so where the question is being
  // asked — in the field's own placeholder-adjacent notice row — and clears
  // on the next document change. The Session card raises a pane bulletin for
  // this; the Overview has no pane chrome of its own to raise one in, and a
  // notice inside the composer is where the reader is already looking.
  const [attachmentError, setAttachmentError] = React.useState<string | null>(
    null,
  );
  const onAttachmentError = useCallback((message: string): void => {
    setAttachmentError(message);
  }, []);
  useLayoutEffect(() => {
    if (attachmentError === null) return;
    setAttachmentError(null);
    // Cleared by the next composition change, which is what `composeImageAtoms`
    // moving means — a successful attach, or the removal of the chip that
    // landed in place of the rejected one.
  }, [composeImageAtoms]); // eslint-disable-line react-hooks/exhaustive-deps

  // [L11] responder side of the strip's ✕: this component owns the editor
  // document and the composer's bytes, so it is what performs a removal the
  // preview's controls only ask for.
  const removeAttachment = useCallback(
    (atomId: string): void => {
      const view = editorRef.current?.view() ?? null;
      if (view !== null) removeAtomById(view, atomId);
      bytesStore.delete(atomId);
    },
    [bytesStore],
  );
  const { ResponderScope: ComposerResponderScope, responderRef } = useResponder({
    id: "overview-composer",
    actions: {
      [TUG_ACTIONS.REMOVE_ATTACHMENT]: (event) => {
        if (typeof event.value !== "string") return;
        removeAttachment(event.value);
      },
    },
  });

  const submit = (): void => {
    if (pending) return;
    const store = getOverviewStore();
    if (store === null) return;
    const state = editorRef.current?.captureState();
    if (state === undefined) return;
    // Atoms flatten to their values — an `@`-completed path survives as the
    // path the Operator can act on. An image atom is NOT flattened (the
    // builder drops it): its payload is the picture, and it travels as an
    // attachment beside the words rather than as the words `image-1`.
    const text = buildSlashCommandLine(
      state.text,
      state.atoms.map((a) => ({
        position: a.position,
        segment: { type: a.type, value: a.value },
      })),
    ).trim();
    // In document order, which is the order the model is shown them in and
    // the order the post's own strip will draw them. An atom whose bytes are
    // gone contributes nothing rather than an empty image block.
    const sent: string[] = [];
    const attachments: OverviewInputAttachment[] = [];
    for (const atom of state.atoms) {
      if (atom.type !== "image" || atom.id === undefined) continue;
      const bytes = bytesStore.get(atom.id);
      if (bytes === null || bytes.content.length === 0) continue;
      sent.push(atom.id);
      attachments.push({ mediaType: bytes.mediaType, data: bytes.content });
    }
    // The same captured atoms a third time, for their other half. The flattened
    // text says the path in a sentence; these say it as a claim the pipeline can
    // check against the tree before it looks anything up. `file` is the only
    // non-image atom this composer can make — its sole completion source is the
    // `@` file provider — so the type test and "non-image" are the same set.
    const refs: OverviewRef[] = state.atoms
      .filter((a) => a.type === "file" && a.value !== "")
      .map((a) => ({ kind: "file" as const, target: a.value }));
    if (text === "" && attachments.length === 0) return;
    if (store.submitQuestion(text, attachments, refs) === null) return;
    // The question comes back off the wire as a post; the field's job is
    // done. `clear` fires the update listener, which resets `data-empty`.
    editorRef.current?.clear();
    // And the bytes' job is done with it: what the post shows from here on is
    // read from where tugcast rested them, not from this store. Holding them
    // would keep every screenshot ever composed alive for the app's life.
    for (const id of sent) bytesStore.delete(id);
  };

  return (
    // The scope is what puts this component on the chain between the preview
    // strip and the card, so the ✕'s `REMOVE_ATTACHMENT` walk finds the thing
    // that owns the document ([L11]).
    <ComposerResponderScope>
    <TugEntryShell
      ref={(el) => {
        shellRef.current = el;
        responderRef(el);
      }}
      className="overview-composer"
      data-slot="overview-composer"
      data-testid="overview-composer"
      data-empty="true"
      accessoryRow={
        composeImageAtoms.length > 0 || attachmentError !== null ? (
          <div
            className="overview-composer-attachments"
            data-slot="overview-composer-attachments"
            // Chrome, like the toolbar: a click on a tile or its ✕ must not
            // take the keyboard away from the field being typed in.
            data-tug-focus="refuse"
          >
            {composeImageAtoms.length > 0 ? (
              <TugAttachmentPreview
                atoms={composeImageAtoms}
                bytesStore={bytesStore}
                deletable
                // The rail's tier, the same one the posts above wear — a
                // picture must not change size when it is sent.
                density="compact"
                data-testid="overview-composer-attachment-strip"
                focusGroup={OVERVIEW_FOCUS_GROUP}
                // After the field and the send button, which are the two
                // stops a question is asked with.
                focusOrderBase={2}
              />
            ) : null}
            {attachmentError !== null ? (
              <TugLabel
                size="xs"
                role="danger"
                className="overview-composer-attachment-error"
                data-testid="overview-composer-attachment-error"
                aria-live="polite"
              >
                {attachmentError}
              </TugLabel>
            ) : null}
          </div>
        ) : undefined
      }
      toolbarTrailing={
        <TugPushButton
          subtype="icon"
          // `sm` — the Find bar's size, not the Session composer's `lg`. Both
          // are one line of entry in a narrow rail, and a 36px button beside a
          // single-line field reads as a button rail with a field above it.
          size="sm"
          emphasis="filled"
          role="action"
          className="overview-composer-send"
          data-testid="overview-composer-send"
          data-tug-entry-default=""
          data-default-chord={submitChord}
          aria-label="Ask the Operator"
          focusGroup={OVERVIEW_FOCUS_GROUP}
          focusOrder={1}
          disabled={pending}
          onClick={submit}
          icon={<ArrowUp size={16} strokeWidth={2.5} />}
        />
      }
    >
      <TugTextEditor
        ref={(delegate) => {
          editorRef.current = delegate;
        }}
        className="overview-composer-field"
        data-testid="overview-composer-field"
        borderless
        lineWrap
        markdownTextStyling
        maxRows={8}
        preserveState={false}
        returnAction={returnAction}
        numpadEnterAction={editorSettings.numpadEnterAction}
        placeholder={
          pending
            ? "Waiting for an answer…"
            : "Ask Tug about your work, recent or historical"
        }
        aria-label="Ask the Operator"
        focusGroup={OVERVIEW_FOCUS_GROUP}
        focusOrder={0}
        disabled={pending}
        completionProviders={completionProviders}
        onSubmit={submit}
        extensions={substrateBridge}
        // What turns a dropped or pasted image into an attachment rather than
        // a filename: the substrate's own pipeline downsamples it, stages the
        // bytes here, and lands the chip.
        attachmentBytesStore={bytesStore}
        onAttachmentError={onAttachmentError}
      />
    </TugEntryShell>
    </ComposerResponderScope>
  );
}
