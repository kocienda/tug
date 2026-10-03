/**
 * ArcVerbRow — every verb an arc offers, in one order and one form, under the
 * block on every arc surface.
 *
 * The set and its order come from {@link arcVerbs}; this component only draws
 * it. The arc's next step leads, outlined; the view follows; a spacer pushes
 * the housekeeping verbs — Bind or Unbind, Replay, Discard — to the trailing
 * edge ([B02]). Every verb is an icon and a word ([B03]): a bare glyph on one
 * surface and a bare word on another was the drift this row ends.
 *
 * **A refused verb is never DOM-disabled** ([B09], [P07]). It renders
 * `aria-disabled` with `data-refused`, keeps its pointer events so the hover
 * can say why, and wears a {@link TugTooltip} whose content is the very
 * sentence its `aria-label` is. A refused transport press also posts its
 * reason to the pane bulletin, exactly as the transport control's always has;
 * the other verbs answer a refused press with nothing but the hover they
 * already show.
 *
 * **The row wraps; it never truncates** ([B11]). At the sidebar's width five or
 * six verbs break onto a second line, which is the accepted cost of every verb
 * staying legible.
 *
 * The transport verbs press through {@link useArcTransportPress}, the one wire
 * path `arc_run` / `arc_resume` / `arc_stop` take. Every other verb is the
 * surface's to perform, through `onVerb`: the surfaces already own those
 * round trips and their confirms, and the row has no business knowing them.
 *
 * Laws: [L06] refused and pending appearance ride `aria-disabled` and `data-*`
 *       with CSS, never React state; [L19] `.tsx`/`.css` pair with
 *       `data-slot`; [L20] it composes {@link TugPushButton}.
 *
 * @module components/tugways/arc-verb-row
 */

import "./arc-verb-row.css";

import React, { useCallback } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import {
  GitCommitHorizontal,
  GitMerge,
  Link2,
  Link2Off,
  Play,
  RotateCcw,
  Square,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { arcPressStore, type ArcTransportVerb } from "@/lib/arc-press-store";
import type { TransportActor } from "@/lib/arc-transport";
import { getConnection } from "@/lib/connection-singleton";
import type {
  ArcTransportVerbEntry,
  ArcVerb,
  ArcVerbKind,
  ArcVerbSet,
} from "@/lib/arc-verbs";

/** The verbs a surface performs itself — everything but the transport. */
export type ArcSurfaceVerbKind = Exclude<ArcVerbKind, ArcTransportVerb>;

/** The CONTROL action each transport verb sends. */
const ACTION_FOR: Record<ArcTransportVerb, string> = {
  start: "arc_run",
  resume: "arc_resume",
  stop: "arc_stop",
};

/**
 * The press of one transport verb, and whether a press is already out.
 *
 * The one wire path `arc_run` / `arc_resume` / `arc_stop` take: the pending
 * bit from {@link arcPressStore} ([L02]), a refusal answered on the pane
 * bulletin of `voice` rather than by a DOM-disabled button ([P07]) — the same
 * voice the server's own refusals arrive in, through the same store ([L31]) —
 * and the one CONTROL frame each verb sends. A *pending* press is refused too,
 * for the opposite reason: the frame is out and a second one would be a
 * second act.
 */
function useArcTransportPress({
  arc,
  verb,
  actor,
  voice,
}: {
  arc: string;
  verb: ArcTransportVerb;
  actor: TransportActor;
  /** The card a refusal speaks on, or null when there is nowhere to speak. */
  voice: string | null;
}): { pending: boolean; press: () => void } {
  const pending = useSyncExternalStore(
    arcPressStore.subscribe,
    () => arcPressStore.isPending(arc, verb),
    () => false,
  );
  const press = useCallback((): void => {
    if (pending) return;
    if (actor.reason !== null) {
      // With no card to speak on, the hover is the surface.
      if (voice !== null) arcPressStore.refuse(voice, arc, verb, actor.reason);
      return;
    }
    const connection = getConnection();
    if (connection === null) {
      // Not silent, and not greyed either: the button stays pressable so a
      // reconnect makes the same press work ([L31]).
      console.warn(`arc ${verb} not sent: no connection`, { arc });
      return;
    }
    arcPressStore.press(arc, verb, actor.tugSessionId);
    // The same three fields for every verb. A Start names no kind: the
    // opening reads that off the arc's documents ([P03]), and a row that
    // should not have offered Start is answered by the server's own refusal
    // naming the address to write to.
    connection.sendControlFrame(ACTION_FOR[verb], {
      tug_session_id: actor.tugSessionId,
      project_dir: actor.projectDir,
      arc,
    });
  }, [actor, arc, pending, verb, voice]);
  return { pending, press };
}

const ICON_FOR: Record<ArcVerbKind, React.ReactElement> = {
  start: <Play />,
  stop: <Square />,
  resume: <Play />,
  join: <GitMerge />,
  changes: <GitCommitHorizontal />,
  diff: <SquareArrowOutUpRight />,
  unbind: <Link2Off />,
  bind: <Link2 />,
  replay: <RotateCcw />,
  discard: <Trash2 />,
};

export interface ArcVerbRowProps {
  /** The arc's display name — what a transport press names. */
  arc: string;
  /** The verb set, from {@link arcVerbs}. */
  verbs: ArcVerbSet;
  /** The card a refused transport press speaks on, or null. */
  voice: string | null;
  /**
   * Perform a surface verb. `anchor` is the pressed button, for a surface that
   * hangs a confirm off the row it sits in.
   */
  onVerb: (kind: ArcSurfaceVerbKind, anchor: HTMLButtonElement | null) => void;
}

/** One verb's button, in the row's one form. */
function VerbButton({
  verb,
  lead,
  pending,
  onPress,
}: {
  verb: ArcVerb;
  /** The first slot is outlined; every other verb is ghost ([B02]). */
  lead: boolean;
  pending: boolean;
  /** Called with the pressed button, for a surface that anchors off it. */
  onPress: (anchor: HTMLButtonElement | null) => void;
}): React.ReactElement {
  const refused = verb.refusal !== null;
  const ref = React.useRef<HTMLButtonElement | null>(null);
  return (
    <TugTooltip content={verb.label}>
      <TugPushButton
        ref={ref}
        data-slot="arc-verb"
        data-verb={verb.kind}
        data-refused={refused ? "true" : undefined}
        data-pending={pending ? "true" : undefined}
        className="tug-arc-verb"
        size="2xs"
        subtype="icon-text"
        emphasis={lead ? "outlined" : "ghost"}
        role={verb.kind === "discard" ? "danger" : "action"}
        icon={ICON_FOR[verb.kind]}
        aria-disabled={refused || pending ? true : undefined}
        aria-label={verb.label}
        onClick={(event) => {
          // A row underneath may be a door ([D142]); this press is its own
          // gesture, so the activation stops here.
          event?.stopPropagation();
          event?.preventDefault();
          onPress(ref.current);
        }}
      >
        {verb.word}
      </TugPushButton>
    </TugTooltip>
  );
}

/** The first slot when it is Start, Stop or Resume — the one verb the row
 *  sends itself. */
function TransportVerb({
  verb,
  arc,
  voice,
}: {
  verb: ArcTransportVerbEntry;
  arc: string;
  voice: string | null;
}): React.ReactElement {
  const { pending, press } = useArcTransportPress({
    arc,
    verb: verb.kind,
    actor: verb.actor,
    voice,
  });
  return (
    <VerbButton verb={verb} lead pending={pending} onPress={() => press()} />
  );
}

export function ArcVerbRow({
  arc,
  verbs,
  voice,
  onVerb,
}: ArcVerbRowProps): React.ReactElement | null {
  const { next, view, housekeeping } = verbs;
  if (next === null && view === null && housekeeping.length === 0) return null;

  const surfacePress =
    (verb: ArcVerb<ArcSurfaceVerbKind>) =>
    (anchor: HTMLButtonElement | null): void => {
      // The hover already says why; a refused press does nothing more.
      if (verb.refusal !== null) return;
      onVerb(verb.kind, anchor);
    };

  return (
    <div className="tug-arc-verb-row" data-slot="arc-verb-row">
      {next === null ? null : next.kind === "join" ? (
        <VerbButton
          verb={next}
          lead
          pending={false}
          onPress={surfacePress(next)}
        />
      ) : (
        <TransportVerb verb={next} arc={arc} voice={voice} />
      )}
      {view === null ? null : (
        <VerbButton
          verb={view}
          lead={false}
          pending={false}
          onPress={surfacePress(view)}
        />
      )}
      {housekeeping.length === 0 ? null : (
        <>
          <span className="tug-arc-verb-row-spacer" aria-hidden="true" />
          {housekeeping.map((verb) => (
            <VerbButton
              key={verb.kind}
              verb={verb}
              lead={false}
              pending={false}
              onPress={surfacePress(verb)}
            />
          ))}
        </>
      )}
    </div>
  );
}
