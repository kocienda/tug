/**
 * settle-crossings.ts — the one record of the crossings a settle holds open.
 *
 * A crossing is a mark on a frame (`lib/fold-crossing.ts`) that holds the
 * card's interior still while the frame's box changes under it. Every mark
 * opened has to be ended on every exit, or the card stands held at a box it
 * no longer has with its end never announced ([L32]). Before this record the
 * marks were opened in `arm` and the Last pass, carried by a hand-assembled
 * set, and ended in six places from three refs, and the class produced three
 * bugs in 48 hours — each a path that ended some of a frame's marks and not
 * the others, which no reader could see from the path itself.
 *
 * So the settle engine owns one `SettleCrossings`, and every mark passes
 * through it:
 *
 * - **Handed** marks are the ones no tween owns yet: a frame `arm` held on the
 *   store's word ({@link SettleCrossings.hold}), and a frame a retarget took
 *   from the settle it cancelled ({@link SettleCrossings.retake}). The next
 *   Last pass either carries each or ends it.
 * - **Live** marks are the ones a launched tween owns, under the id the Last
 *   pass opened, adopted or re-marked them with ({@link SettleCrossings.carry}).
 *   The settle's completion ends them by id ({@link SettleCrossings.end}), so
 *   a completion an interrupted settle lands late cannot close the crossing
 *   its replacement carries on.
 *
 * Every exit that is not a completion — the Last pass's end, the window sweep,
 * the unmount, the no-First-rects return, the declining return — calls
 * {@link SettleCrossings.endAll} or {@link SettleCrossings.closePass}, and a
 * carried frame's marks the carrier did not name are ended by `carry` itself.
 * Nothing is left for a path to remember.
 */

import {
  endFoldCrossing,
  endStillCrossing,
  FOLD_CROSSING_ATTR,
} from "@/lib/fold-crossing";

/** The two kinds of mark a settle opens on a frame. */
export type CrossingKind = "fold" | "still";

/** The ids a carrier holds a frame's marks under, `null` for a kind it does not hold. */
export interface CarriedIds {
  fold: number | null;
  still: number | null;
}

/**
 * The doors the record ends marks through. The real ones by default; a test
 * passes its own, since `bun test` has no DOM to write marks on.
 */
export interface CrossingDoors {
  endFold(frame: HTMLElement, id?: number): void;
  endStill(frame: HTMLElement, id?: number): void;
  foldStanding(frame: HTMLElement): boolean;
}

const DOM_DOORS: CrossingDoors = {
  endFold: endFoldCrossing,
  endStill: endStillCrossing,
  foldStanding: (frame) => frame.hasAttribute(FOLD_CROSSING_ATTR),
};

/** How a frame came to be handed to the next Last pass. */
interface Handed {
  /** A retarget cancelled the tween that owned its marks: both kinds may stand. */
  retaken: boolean;
  /** The door `arm` opened it with, or `null` when `arm` did not hold it. */
  armed: CrossingKind | null;
}

export class SettleCrossings {
  private readonly handed = new Map<HTMLElement, Handed>();
  private readonly live = new Map<HTMLElement, CarriedIds>();

  constructor(private readonly doors: CrossingDoors = DOM_DOORS) {}

  /** `arm` opened `kind` on `frame` before the commit that resizes it. */
  hold(frame: HTMLElement, kind: CrossingKind): void {
    this.entry(frame).armed = kind;
  }

  /**
   * Start an `arm`'s prediction. The holds an earlier `arm` left unconfirmed —
   * two arms in one task, one coalesced commit — are forgotten as holds, and
   * the returned `finish` ends every one this arm did not {@link hold} again,
   * by the door it was opened with. A frame a retarget also handed keeps that
   * claim: only the arm's own hold is stale.
   */
  beginArm(): () => void {
    const stale = new Map<HTMLElement, CrossingKind>();
    for (const [frame, h] of this.handed) {
      if (h.armed === null) continue;
      stale.set(frame, h.armed);
      h.armed = null;
      if (!h.retaken) this.handed.delete(frame);
    }
    return () => {
      for (const [frame, kind] of stale) {
        if (this.handed.get(frame)?.armed != null) continue;
        this.endKind(frame, kind);
      }
    };
  }

  /**
   * A retarget cancelled the tween carrying `frame`: the cancelled settle's
   * completion is now a no-op, so whatever it held is the next Last pass's to
   * carry on or to end.
   */
  retake(frame: HTMLElement): void {
    this.live.delete(frame);
    this.entry(frame).retaken = true;
  }

  /**
   * A pointer gesture took `frame` from the settle: every mark on it comes
   * off now, unguarded, and the record forgets it.
   */
  release(frame: HTMLElement): void {
    this.handed.delete(frame);
    this.live.delete(frame);
    this.doors.endFold(frame);
    this.doors.endStill(frame);
  }

  /**
   * End a fold standing on `frame` before its carrier opens a still crossing
   * alone. The fold's end takes the still mark with it, so this must run
   * before the carrier's still mark is written, never after: a carrier that
   * neither tweens the height nor folds has no fold to carry, and a fold left
   * standing beside its still mark would hold the card at the fold's height
   * past the land. Returns whether it ended one.
   */
  yieldFold(frame: HTMLElement): boolean {
    if (!this.doors.foldStanding(frame)) return false;
    this.doors.endFold(frame);
    return true;
  }

  /**
   * The Last pass carries `frame` under `ids`. Every handed mark on it the
   * carrier did not name is ended now, and the named ones become live, ended
   * by the settle's completion through {@link end}.
   *
   * A carrier naming the still crossing and not the fold has already yielded
   * any fold ({@link yieldFold}) — the fold's end would take its still mark
   * with it — so only a carrier holding neither kind ends a handed fold here.
   */
  carry(frame: HTMLElement, ids: CarriedIds): void {
    const h = this.handed.get(frame);
    this.handed.delete(frame);
    if (h !== undefined) {
      const kinds = kindsOf(h);
      if (kinds.has("fold") && ids.fold === null && ids.still === null) {
        this.doors.endFold(frame);
      }
      if (kinds.has("still") && ids.still === null) this.doors.endStill(frame);
    }
    if (ids.fold !== null || ids.still !== null) this.live.set(frame, ids);
  }

  /**
   * The settle that carried `frame` has landed: end its marks under the ids
   * it carried them with — the fold first, which announces the fold's end —
   * and forget the frame unless a later settle carries it now.
   */
  end(frame: HTMLElement, ids: CarriedIds): void {
    if (ids.fold !== null) this.doors.endFold(frame, ids.fold);
    if (ids.still !== null) this.doors.endStill(frame, ids.still);
    const live = this.live.get(frame);
    if (live !== undefined && live.fold === ids.fold && live.still === ids.still) {
      this.live.delete(frame);
    }
  }

  /**
   * The Last pass has carried what it carries: every frame still handed —
   * covered, sliding, arriving, gone, or over-predicted by `arm` — is ended
   * now, in the pass that knows.
   */
  closePass(): void {
    for (const [frame, h] of this.handed) {
      for (const kind of kindsOf(h)) this.endKind(frame, kind);
    }
    this.handed.clear();
  }

  /**
   * An exit that no completion will follow — the window sweep, the unmount,
   * a Last pass with nothing to carry or declining to: every handed mark and
   * every live one comes off, unguarded, since no crossing of any vintage
   * should outlive it.
   */
  endAll(): void {
    this.closePass();
    for (const frame of this.live.keys()) {
      this.doors.endFold(frame);
      this.doors.endStill(frame);
    }
    this.live.clear();
  }

  /** The frames the record holds anything for, for a test to read. */
  get size(): { handed: number; live: number } {
    return { handed: this.handed.size, live: this.live.size };
  }

  private entry(frame: HTMLElement): Handed {
    let h = this.handed.get(frame);
    if (h === undefined) {
      h = { retaken: false, armed: null };
      this.handed.set(frame, h);
    }
    return h;
  }

  /**
   * End one kind, unguarded. A fold is ended by the fold's door, which ends
   * the still mark with it and announces both; a still crossing by its own,
   * which leaves a fold from an earlier settle to that settle.
   */
  private endKind(frame: HTMLElement, kind: CrossingKind): void {
    if (kind === "fold") this.doors.endFold(frame);
    else this.doors.endStill(frame);
  }
}

/**
 * The kinds a handed frame may hold. A retaken frame may hold either, and
 * both doors are tried — the fold's ends nothing when no fold stands, and
 * then the still door is the one that ends the still mark.
 */
function kindsOf(h: Handed): Set<CrossingKind> {
  const kinds = new Set<CrossingKind>();
  if (h.retaken) {
    kinds.add("fold");
    kinds.add("still");
  }
  if (h.armed !== null) kinds.add(h.armed);
  return kinds;
}
