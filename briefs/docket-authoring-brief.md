# Authoring from the docket: ideas, sketches, briefs and arcs by gesture

**Purpose:** Work in Tug starts in a session prompt and nowhere else, so an idea has no home until someone is ready to act on it, and a sketch cannot be edited once the arc door has written it. This brief makes the Docket card the place where work starts and is revised.

This is brief 3 of 4 for the docket design. It depends on `briefs/arc-and-sketch-identity-brief.md` (durable arcs and sketches, their atoms) and `briefs/docket-record-and-card-brief.md` (the docket record and card). `briefs/docket-loop-brief.md` follows.

---

## Purpose {#purpose}

The user wants the docket to be "an iteration start and end point, a place where work begins, ends, and then continues": "I could add in new ideas, generate sketches and briefs, kick off arcs." And the arc card should "fluidly link back … so I could edit a sketch, generate (or regenerate) a brief and arc", helping "at the point of their attention".

Tito asked how each step is triggered: whether the sketch is free-form, whether the brief is written by a button or in real time, and what the button becomes once a brief exists.

---

## Evidence {#evidence}

**[F01] The Sketch panel cannot be pressed.** `tugdeck/src/components/tugways/cards/session-arc-panels.tsx` names the sketch rung as the one unpressable panel; a press does nothing. **(verified)**

**[F02] The sketch record is written by the model in a fixed shape, and stages rewrite it.** The arc doctrine (`tugplug/doctrine/arc-work-doctrine.md`) has every stage read `sketch.md`, and rewrite it when its source session has later turns or when it "is not in the shape above". A user's hand-edited text would not be in that shape and would be rewritten. **(verified)**

**[F03] A sketch is only recorded at the `/arc` door.** `tugplug/skills/arc/SKILL.md` writes it as part of opening an arc. A conversation that converges and does not open an arc leaves no sketch. **(verified)**

**[F04] The brief and arc gestures already exist as commands.** `/tugplug:brief` writes and commits a brief and prints `/arc <slug> @<path>`; `/arc` opens the arc. **(verified)**

**[F05] An idea has no object.** The work grammar defines an idea as "written by the user as a prompt". **(verified)**

---

## Decisions {#decisions}

**[B01] An idea is an object held by a docket.** It has an id, one line, and an optional body. It is not a jot; the user ruled jots wholly separate. It gets an atom and `tugtool idea show`, on brief 1's pattern.

**[B02] The Docket card has a capture field.** One line at the top adds an idea to the inbox without opening anything else.

**[B03] Sketch it opens a session on an idea.** The idea is the session's prompt and the session is filed in the idea's thread. The conversation is the sketching, as it is today.

**[B04] Keep sketch is its own gesture.** It records the session's converged sketch as a new version of the thread's sketch, with its source session and turns. The `/arc` door still records one when no sketch exists yet ([F03]); with a kept sketch it uses that one.

**[B05] A sketch can be edited by hand, in the card, free-form.** Each save is a new version. This answers Tito's first question.

**[B06] A hand-edited sketch is never rewritten by a stage.** The doctrine's rewrite rule ([F02]) applies only to a version the model wrote. A version the user wrote is marked as theirs, and a stage that disagrees with it stops and says so; it does not replace it.

**[B07] Nothing regenerates live.** The user presses **Write brief**. Once a brief exists the button reads **Revise brief**, and revising makes a new version while the old one stays readable. The same holds for **Open arc**.

**[B08] A change upstream marks downstream stale and changes nothing else.** A brief records which sketch version it was written from, and an arc which brief version it opened on. When the upstream version moves, the downstream object shows stale and names the version it came from.

**[B09] The gestures run the existing commands.** Write brief runs the brief skill in a session; Open arc runs `/arc` on the brief. The card adds no second way to write a brief or open an arc ([F04]).

**[B10] Objects made from the card are filed in the same thread.** A sketch from an idea, a brief from a sketch and an arc from a brief need no filing by hand.

**[B11] The arc card's panels become doors.** Pressing Sketch opens that sketch in the Docket card for editing, and pressing Brief opens the brief's thread. For an arc on no docket the panels behave as today ([F01]).

**[B12] The work grammar gains the idea as an object and the new gestures.** `tuglaws/work-grammar.md` and `tugplug/work-grammar.md` are updated in the same arc.

---

## Open Questions {#open-questions}

- **Which session writes the brief.** The sketch's source session has the conversation in context and writes the better brief, but may be long gone or full. A fresh session reads only the sketch record. The recommendation is the source session when it is live, otherwise a fresh one that is given the sketch and its source turns.
- **How Keep sketch reaches the model.** A plugin skill the card invokes in the session, or a button that sends a fixed prompt. A skill ships the shape rule with it.
- **What Open arc does about staleness it can see.** If the brief is stale against its sketch when Open arc is pressed, the card can refuse, warn, or proceed.
- **Where a brief version is snapshotted.** Brief 2 has the docket hold snapshots; whether Revise brief overwrites the file in `briefs/` or writes a new file beside it follows from the brief skill's never-overwrite rule and needs settling.

---

## Non-goals {#non-goals}

- **Live regeneration.** Rejected by Tito and the user alike: a brief rewriting itself while the user types is a distraction ([B07]).
- **A skeleton or lint for sketches.** A sketch stays informal.
- **Changing a running arc when its brief moves.** This brief only marks the arc stale. What can be done about it is the loop brief.
- **Jots.** Separate.
- **A second brief-writing or arc-opening path.** Ruled out by [B09].

---

## Exit {#exit}

**An arc.** Its parts, in order:

1. The idea object, its atom and verb, and the capture field.
2. Sketch it, Keep sketch, and hand editing with the ownership rule of [B06].
3. Write brief, Revise brief and Open arc, with version links and stale markers.
4. The arc card's panel doors, and the work grammar changes.
