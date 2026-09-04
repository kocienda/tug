/**
 * spike-commit-atom.tsx — what does a commit look like when it is its own
 * atom, rather than one more annotated resource?
 *
 * A commit is not a file reference. It is immutable, it is addressed by a
 * hash nobody chose, and it is the unit the whole app's work lands in — and
 * today it wears the same read-only skin (`TugAtomRef`: glyph, label,
 * resting underline) that a `file_path` in a tool header wears. The two are
 * the same mark, so a transcript paragraph that names one arc, one file and
 * four commits reads as six undifferentiated blue runs, and the run of four
 * shas wraps into a rubble field. That is the picture this spike is
 * answering.
 *
 * **The neighbours already settled their own looks.** An arc and a session
 * are pills — 22px, sans, rounded, a border at 30% currentcolor, one dot of
 * color — because they are *named objects* somebody can hold in their head
 * (`tug-session-identity.css`'s chip tier, reached through
 * {@link TugArcAtom}). A commit is not that: nobody named it, and its name
 * is eight hex characters nobody chose. So a commit atom cannot simply be a
 * third pill, and it cannot stay generic ink either. It needs a look of its
 * own that is legibly a *sibling* of the pill without being one.
 *
 * **The face is the surface's, not the atom's.** The candidates set no
 * `font-family` at all, so a commit atom is proportional in a transcript
 * paragraph and mono in a composer line or a History row — the same way every
 * other atom behaves. A hash pinned to mono everywhere makes the mark shout
 * its machine-ness on surfaces that did not ask, and puts a commit in a
 * different typeface from the arc pill standing beside it. `tug-atom-ref.css`
 * pins mono today; whichever candidate graduates reverses that pin, and the
 * transcript and composer benches are where the two faces are compared.
 *
 * Four candidates, drawn side by side on every surface a commit is named on:
 *
 *   1. **Node pill** — the pill enclosure the arc and session already wear,
 *      with the hash inside it. Says a commit is a named object, exactly
 *      like its neighbours. The cost is that four of them in a row is four
 *      boxes.
 *   2. **Rail** — no enclosure at all: a node with a hairline of rail either
 *      side, then the hash. Borrows the commit graph's own vocabulary,
 *      which is the one picture every reader of this app already has of what
 *      a commit is. Cheapest in a run; weakest standing alone.
 *   3. **Slab** — the sha on a faint tinted field, squared where the node
 *      attaches and rounded away from it: a tag hung off a point in history.
 *      Reads as machine fact rather than as a name, which is what a hash is.
 *   4. **Ink** — the quietest: node plus hash, no field, no word, a
 *      hairline rule under the hash only. The run-of-many case's best
 *      behaviour, and the one that risks vanishing back into prose.
 *
 * **Two axes cut across all four**, which is why they are toggles rather
 * than baked into each drawing:
 *
 *   - **Does the label carry the word?** Today's atom prints
 *     `commit:6961fe36` because eight bare hex characters name nothing and a
 *     small glyph was judged not to rescue them
 *     (`tug-atom-ref.tsx`). If a commit gets a look of its own, the look may
 *     now be doing that work — and the word costs seven characters in every
 *     run of four. This is the spike's sharpest question.
 *   - **Which register?** `prose` (22px) and `reading` (24px), from
 *     `lib/atom-register.ts` — the same table the pills are sized by, so a
 *     commit atom that adopts a box adopts that box's height rather than
 *     inventing one.
 *
 * **The benches are the point, not the specimens.** Five surfaces, because
 * "everywhere in the app" is a claim only a surface can falsify: a
 * transcript paragraph at 14px prose, a composer line in mono, a run of four
 * shas with an arc pill beside them (the screenshot that prompted this), a
 * History shade row, and a reading-scale block. A candidate that wins one
 * bench and loses another has not won — and the first two are one test, not
 * two: the shape has to read as one mark across both faces.
 *
 * The status quo is drawn from the real {@link CommitShaText} throughout, so
 * the "before" is what the app renders and not a reconstruction of it. The
 * arc pill beside it is the real {@link TugArcAtom}. The four candidates are
 * drawings — that is what makes them candidates.
 *
 * Getting out: whichever candidate settles becomes a `TugCommitAtom` in
 * `components/tugways/`, `CommitShaText` keeps its gesture ownership and
 * mounts it instead of `TugAtomRef`, the doctrine paragraph joins
 * `tuglaws/entity-presentation.md`, and this file is deleted.
 *
 * @module spikes/spike-commit-atom
 */

import "./spike.css";
import type { SpikeDef } from "./spike-registry";
import "./spike-commit-atom.css";

import React, { useId, useState } from "react";

import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TugOptionGroup } from "@/components/tugways/tug-option-group";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { TugArcAtom } from "@/components/tugways/tug-arc-atom";
import { CommitShaText } from "@/components/tugways/commit-sha-text";
import {
  DEFAULT_ATOM_REGISTER,
  atomRegisterVars,
  type AtomRegister,
} from "@/lib/atom-register";
import { COMMIT_LABEL_LENGTH } from "@/lib/commit-format";

// ---------------------------------------------------------------------------
// Fixtures — the shas from the transcript that prompted the spike
// ---------------------------------------------------------------------------

/** The run of four the Observer's report ended with, verbatim. */
const RUN = ["6961fe36", "a3e815dd", "b63c726c", "346af9df"];

/** One sha, for the standing-alone benches. */
const ONE = RUN[0];

/** The arc those commits landed on. */
const ARC = "tug/velvet-patio";

// ---------------------------------------------------------------------------
// The candidates
// ---------------------------------------------------------------------------

/** Which drawing an atom is wearing. */
type Candidate = "pill" | "rail" | "slab" | "ink";

const CANDIDATES: readonly { key: Candidate; title: string; gist: string }[] = [
  {
    key: "pill",
    title: "Node pill",
    gist: "The arc and session enclosure, with the hash inside it. A commit is a named object like its neighbours — at the cost of a box per sha.",
  },
  {
    key: "rail",
    title: "Rail",
    gist: "The commit graph's own vocabulary: a node with a hairline of rail either side. No enclosure, so a run of four costs almost nothing.",
  },
  {
    key: "slab",
    title: "Slab",
    gist: "A faint field, squared where the node attaches and rounded away from it. Reads as machine fact rather than as a name — which is what a hash is.",
  },
  {
    key: "ink",
    title: "Ink",
    gist: "Node, hash, a hairline under the hash alone. The quietest — best in a run, most at risk of dissolving back into the prose.",
  },
];

/**
 * A candidate commit atom.
 *
 * All four share one element tree — node, hash, optional word — and differ
 * only in what the stylesheet paints around it, because that is the honest
 * way to compare four *looks* rather than four implementations. The node is
 * drawn in CSS rather than mounted as a lucide `GitCommit`: at 6px the icon's
 * own rail strokes are the thing being varied, so they have to be ours.
 */
function CommitAtom({
  sha,
  candidate,
  word,
  register = DEFAULT_ATOM_REGISTER,
}: {
  sha: string;
  candidate: Candidate;
  /** Print `commit:` before the hash. */
  word: boolean;
  register?: AtomRegister;
}): React.ReactElement {
  return (
    <span
      className="ca-atom"
      data-slot="ca-atom"
      data-candidate={candidate}
      data-register={register}
      style={atomRegisterVars(register)}
    >
      <span className="ca-node" aria-hidden="true" />
      <span className="ca-text">
        {word ? <span className="ca-word">commit:</span> : null}
        <span className="ca-sha">{sha.slice(0, COMMIT_LABEL_LENGTH)}</span>
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

function Caption({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="ca-caption">{children}</p>;
}

/** One labelled cell in a bench — the candidate's name over its drawing. */
function Cell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="ca-cell">
      <span className="ca-cell-title">{title}</span>
      <div className="ca-cell-body">{children}</div>
    </div>
  );
}

const WORD_ITEMS = [{ value: "word", label: "Carry the word “commit:”" }];

const REGISTER_ITEMS = [
  { value: "prose", label: "Prose (22px)" },
  { value: "reading", label: "Reading (24px)" },
];

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export function SpikeCommitAtom(): React.ReactElement {
  // The two axes that cut across every candidate. Toggles rather than baked
  // variants, because the question is whether the LOOK can carry what the
  // word carries — which only shows when both are drawn the same way.
  const [word, setWord] = useState<string[]>(["word"]);
  const [register, setRegister] = useState<string[]>(["prose"]);
  const wordId = useId();
  const registerId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    setValueStringArray: { [wordId]: setWord, [registerId]: setRegister },
  });

  const carriesWord = word.includes("word");
  const reg: AtomRegister = register.includes("reading") ? "reading" : "prose";

  /** One candidate's atom, at the current axis settings. */
  const atom = (candidate: Candidate, sha: string = ONE): React.ReactElement => (
    <CommitAtom sha={sha} candidate={candidate} word={carriesWord} register={reg} />
  );

  return (
    <ResponderScope>
      <div
        className="sp-content"
        data-testid="spike-commit-atom"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        {/* ── The axes ─────────────────────────────────────────────── */}
        <section className="sp-section">
          <h2 className="sp-section-title">Axes</h2>
          <Caption>
            Both cut across all four candidates. The word question is the sharp one:
            today’s atom prints <code>commit:6961fe36</code> because eight bare hex
            characters name nothing and a small glyph was judged not to rescue them. If a
            commit gets a look of its own, the look may now be doing that work — and the
            word costs seven characters in every run of four.
          </Caption>
          <div className="ca-axes">
            <TugOptionGroup
              value={word}
              senderId={wordId}
              size="xs"
              aria-label="Label content"
              data-testid="commit-atom-word"
              items={WORD_ITEMS}
            />
            <TugOptionGroup
              value={register}
              senderId={registerId}
              size="xs"
              aria-label="Atom register"
              data-testid="commit-atom-register"
              items={REGISTER_ITEMS}
            />
          </div>
        </section>

        <TugSeparator />

        {/* ── The problem ──────────────────────────────────────────── */}
        <section className="sp-section">
          <h2 className="sp-section-title">The picture that prompted this</h2>
          <Caption>
            Real components: the arc is <code>TugArcAtom</code>, the shas are
            <code>CommitShaText</code>. The arc is an object you can hold; the four commits
            beside it are the same generic ink a <code>file_path</code> in a tool header
            wears, so they read as a rubble field rather than as four landings.
          </Caption>
          <div className="ca-prose ca-before">
            <p>
              Reviewed W2’s report and gave thumbs up: broadcast ordering,{" "}
              <code>DashRecords::{"{Known, Unreadable}"}</code> gate, and verdict-bearing
              verbs all landed clean.
            </p>
            <p className="ca-run">
              <TugArcAtom name={ARC} register="prose" />
              {RUN.map((sha) => (
                <CommitShaText key={sha} sha={sha} menu={false} />
              ))}
            </p>
          </div>
        </section>

        <TugSeparator />

        {/* ── The four candidates ──────────────────────────────────── */}
        <section className="sp-section">
          <h2 className="sp-section-title">Four looks</h2>
          {CANDIDATES.map((c) => (
            <div className="ca-candidate" key={c.key}>
              <div className="ca-candidate-head">
                <TugLabel size="sm">{c.title}</TugLabel>
                {atom(c.key)}
              </div>
              <Caption>{c.gist}</Caption>
            </div>
          ))}
        </section>

        <TugSeparator />

        {/* ── Bench 1: prose ───────────────────────────────────────── */}
        <section className="sp-section">
          <h2 className="sp-section-title">Bench — a transcript sentence (14px prose)</h2>
          <Caption>
            The commonest case by far, and the one where an atom must be legible as an
            object without shouting over the sentence holding it.
          </Caption>
          <div className="ca-bench">
            {CANDIDATES.map((c) => (
              <Cell title={c.title} key={c.key}>
                <p className="ca-prose">
                  The broadcast-ordering fix landed in {atom(c.key)} and the gate followed
                  it an hour later.
                </p>
              </Cell>
            ))}
          </div>
        </section>

        <TugSeparator />

        {/* ── Bench 2: text entry ──────────────────────────────────── */}
        <section className="sp-section">
          <h2 className="sp-section-title">Bench — a composer line (text entry)</h2>
          <Caption>
            The face is the <em>surface’s</em>, not the atom’s: an atom comes out mono
            here and proportional in the transcript above, the same way every other atom
            behaves, because the typeface is a fact about where the reader is rather than
            about what a commit is. Nothing in the candidates sets a{" "}
            <code>font-family</code> at all — this bench is mono because a composer line
            is. Compare each drawing against its twin two sections up: the shape must be
            recognisably one mark across the two faces, which is the real test.
          </Caption>
          <div className="ca-bench">
            {CANDIDATES.map((c) => (
              <Cell title={c.title} key={c.key}>
                <div className="ca-composer">
                  <span>land {atom(c.key)} on the arc and open the shade</span>
                  <span className="ca-caret" aria-hidden="true" />
                </div>
              </Cell>
            ))}
          </div>
        </section>

        <TugSeparator />

        {/* ── Bench 3: the run ─────────────────────────────────────── */}
        <section className="sp-section">
          <h2 className="sp-section-title">Bench — four in a row, beside an arc</h2>
          <Caption>
            The failure case from the screenshot. A candidate wins here by staying legible
            as four separate landings while costing the paragraph as little as possible —
            and by not competing with the arc pill, which is a different kind of thing and
            must keep reading as one.
          </Caption>
          <div className="ca-bench">
            {CANDIDATES.map((c) => (
              <Cell title={c.title} key={c.key}>
                <p className="ca-prose ca-run">
                  <TugArcAtom name={ARC} register={reg} />
                  {RUN.map((sha) => (
                    <React.Fragment key={sha}>{atom(c.key, sha)}</React.Fragment>
                  ))}
                </p>
              </Cell>
            ))}
          </div>
        </section>

        <TugSeparator />

        {/* ── Bench 4: mono context ────────────────────────────────── */}
        <section className="sp-section">
          <h2 className="sp-section-title">Bench — a History shade row (mono context)</h2>
          <Caption>
            The surface that taught the pills to pin their own face: dropped into a mono
            row, an atom that inherits its host comes out in a weight and width nothing
            about the mark asked for. Here the surrounding row IS mono and the hash is
            mono too — so the question inverts. Does the atom still read as an object when
            everything around it is already code?
          </Caption>
          <div className="ca-bench">
            {CANDIDATES.map((c) => (
              <Cell title={c.title} key={c.key}>
                <div className="ca-history-row">
                  {atom(c.key)}
                  <span className="ca-history-subject">
                    tugarc(arc-unification): make an arc read as one thing
                  </span>
                  <span className="ca-history-meta">6:33 AM</span>
                </div>
              </Cell>
            ))}
          </div>
        </section>

        <TugSeparator />

        {/* ── Bench 5: reading scale ───────────────────────────────── */}
        <section className="sp-section">
          <h2 className="sp-section-title">Bench — a reading-scale block (13px)</h2>
          <Caption>
            The Changes shade and an Overview post’s trailing refs row: a block with no
            line of running text to disturb, where the mark is allowed to breathe. This is
            the bench the <code>reading</code> register exists for — flip the axis above
            and only the box height moves, by two pixels.
          </Caption>
          <div className="ca-bench">
            {CANDIDATES.map((c) => (
              <Cell title={c.title} key={c.key}>
                <div className="ca-refs-row">
                  <span className="ca-refs-label">Cites</span>
                  {RUN.slice(0, 2).map((sha) => (
                    <React.Fragment key={sha}>{atom(c.key, sha)}</React.Fragment>
                  ))}
                </div>
              </Cell>
            ))}
          </div>
        </section>

        <TugSeparator />

        {/* ── States ───────────────────────────────────────────────── */}
        <section className="sp-section">
          <h2 className="sp-section-title">States</h2>
          <Caption>
            Whatever wins has to answer these four, because the current atom already does.
            <strong> Rest</strong> and <strong>hover</strong>: a commit is a copy target,
            not a link, so hover may darken or firm the mark but must not make a link’s
            promise. <strong>Unresolvable</strong>: the shape survives and the ink mutes —
            a reader still needs to know what kind of thing failed to resolve.
            <strong> Matched</strong>: a transcript Find decorates the hash characters and
            leaves the enclosure and the word alone.
          </Caption>
          <div className="ca-bench">
            {CANDIDATES.map((c) => (
              <Cell title={c.title} key={c.key}>
                <div className="ca-states">
                  <span className="ca-state">
                    <span className="ca-state-name">rest</span>
                    {atom(c.key)}
                  </span>
                  <span className="ca-state" data-force-hover="true">
                    <span className="ca-state-name">hover</span>
                    {atom(c.key)}
                  </span>
                  <span className="ca-state ca-state-missing">
                    <span className="ca-state-name">missing</span>
                    {atom(c.key)}
                  </span>
                  <span className="ca-state ca-state-matched">
                    <span className="ca-state-name">matched</span>
                    {atom(c.key)}
                  </span>
                </div>
              </Cell>
            ))}
          </div>
        </section>

        <TugSeparator />

        {/* ── Constraints ──────────────────────────────────────────── */}
        <section className="sp-section">
          <h2 className="sp-section-title">What the winner must not do</h2>
          <Caption>
            Recorded so they are not re-proposed. <strong>No third pill.</strong> The
            rounded 22px enclosure means “named object” and belongs to sessions and arcs;
            a commit borrowing it whole erases a distinction the app spent a while
            earning — which is exactly why the Node pill candidate is here to be argued
            against rather than assumed.
            <strong> No per-sha hashed tint.</strong> Already retired for sessions, for
            the same reason: a color nothing explains is noise wearing meaning’s clothes.
            <strong> No link affordance.</strong> The gestures stop at{" "}
            <code>CommitShaText</code> — a commit atom is a copy target, and a pointer
            cursor promises a navigation that never comes.
            <strong> No second set of numbers.</strong> If the winner takes a box, the box
            is <code>lib/atom-register.ts</code>’s, so a live atom and a Canvas bake of it
            cannot be two sizes.
            <strong> No pinned typeface.</strong> A hash is not always mono: the face
            follows the surface, proportional in the transcript and mono in text entry,
            exactly as the atoms beside it behave. A candidate that only works in one of
            the two faces has not won — which is what the composer bench is for.
          </Caption>
        </section>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "commit-atom",
  title: "Commit Atom",
  blurb:
    "What does a commit look like when it is its own atom, not one more annotated resource?",
  icon: "GitCommit",
  component: () => <SpikeCommitAtom />,
};
