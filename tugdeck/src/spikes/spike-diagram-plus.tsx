/**
 * spike-diagram-plus.tsx — what would make each `/explain` diagram form
 * say more, and say it more clearly?
 *
 * One section per form: `layers`, `stack`, `sequence`, `flow`. Each shows
 * the same subject twice. **Today** is the shipped form, drawn by the real
 * renderer from a `tugdiagram` spec, so it is exactly what an explainer
 * shows now. **Plus** is the form with this spike's changes applied, laid
 * out in `spike-diagram-plus-layout.ts` and drawn by the same engine, so
 * colour and type are the shipping ones and only the layout and the pen
 * differ. Under the pair is the list of changes, each tagged by where it
 * lands:
 *
 *  - **look**: the pen every form draws with (weight, heads, chips);
 *  - **layout**: where a form puts what it already has;
 *  - **spec**: a new field, so the author can say something the form
 *    cannot say today.
 *
 * What to judge: whether each change earns its place, whether the one
 * connector (2 px, full ink, an 11 px head, its label in a chip on the
 * line) is right for all four forms, and which of the new spec fields are
 * worth teaching in `tugplug/diagrams.md`.
 *
 * Nothing here ships. What survives is ported to
 * `crates/tuggraphics/src/diagram/`.
 *
 * @module spikes/spike-diagram-plus
 */

import "./spike.css";
import "@/components/tugways/body-kinds/chart-block.css";
import "./spike-diagram-plus.css";

import React, { useLayoutEffect, useRef } from "react";

import { TugBadge } from "@/components/tugways/tug-badge";
import { TugLabel } from "@/components/tugways/tug-label";
import { awaitRoleFaces, ensureRoleProbes, probeMeasurer, roleFacesLoaded } from "@/lib/chart/chart-measure";
import { renderChartInto } from "@/lib/chart/render-chart";
import { loadTuggraphics } from "@/lib/lazy/load-tuggraphics";

import { layoutPlus, type PlusSpec } from "./spike-diagram-plus-layout";
import { SUBJECTS, type Kind, type Note, type Subject } from "./spike-diagram-plus-subjects";
import type { SpikeDef } from "./spike-registry";

/** Text with an ascender, a descender and digits, to ask the faces for. */
const FACE_SAMPLE = "Hamburgefonstiv 0123";

let figureSeq = 0;

/** The shipped form: the one renderer, given a `tugdiagram` source. */
function TodayFigure({ spec }: { spec: Record<string, unknown> }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    void renderChartInto(el, JSON.stringify(spec), { layers: "diagram" });
  }, [spec]);
  return <div className="sp-dp-figure" ref={ref} />;
}

/** Lays the proposed form out and renders its program into `body`; all DOM writes. */
async function drawPlus(root: HTMLElement, body: HTMLElement, readout: HTMLElement, spec: PlusSpec, live: () => boolean): Promise<void> {
  const engine = await loadTuggraphics();
  if (!live()) return;
  const probes = ensureRoleProbes(root);
  if (!roleFacesLoaded(probes, FACE_SAMPLE)) await awaitRoleFaces(probes, FACE_SAMPLE);
  if (!live()) return;
  const measure = probeMeasurer(probes);
  if (measure === null) {
    readout.textContent = "no canvas to measure text with";
    return;
  }
  let reading: string;
  try {
    const drawn = layoutPlus(
      spec,
      false,
      (role, text) => measure(role, text),
      (role, text) => measure(role, text, true).ink ?? { l: 0, r: 0, a: 0, d: 0 },
    );
    const out = engine.render_program(drawn.program, `spdp${++figureSeq}`);
    if (out.status === "done") {
      // The engine's own SVG, built from a validated program: no author text reaches it as markup.
      body.innerHTML = out.svg;
      const over = drawn.width > 1040 ? `, ${drawn.width - 1040} px over the 1,040 px limit` : "";
      reading = `${drawn.width} × ${drawn.height}${over}`;
    } else {
      body.textContent = "";
      reading = out.errors.map((e) => `op ${e.op ?? "—"}: ${e.message}`).join("\n");
    }
  } catch (err) {
    body.textContent = "";
    reading = err instanceof Error ? err.message : String(err);
  }
  readout.textContent = reading;
}

function PlusFigure({ spec }: { spec: PlusSpec }): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const body = bodyRef.current;
    const readout = readoutRef.current;
    if (root === null || body === null || readout === null) return;
    let alive = true;
    void drawPlus(root, body, readout, spec, () => alive);
    return () => {
      alive = false;
    };
  }, [spec]);

  return (
    <div>
      <div className="tugx-chart sp-dp-figure sp-dp-plus" data-tugx-chart-state="rendered" ref={rootRef}>
        <div className="tugx-chart-body" ref={bodyRef} />
      </div>
      <div className="sp-dp-readout" ref={readoutRef} />
    </div>
  );
}

const KIND_ROLE: Record<Kind, "action" | "data" | "agent"> = { look: "data", layout: "action", spec: "agent" };

function NoteRow({ n, note }: { n: number; note: Note }): React.ReactElement {
  return (
    <li className="sp-dp-note">
      <span className="sp-dp-note-n">{n}</span>
      <div className="sp-dp-note-text">
        <div className="sp-dp-note-head">
          <span className="sp-dp-note-title">{note.title}</span>
          <TugBadge size="2xs" role={KIND_ROLE[note.kind]}>{note.kind}</TugBadge>
          {note.drawn ? null : (
            <TugBadge size="2xs" emphasis="outlined" role="caution">not drawn</TugBadge>
          )}
        </div>
        <p className="sp-dp-note-body">{note.body}</p>
      </div>
    </li>
  );
}

function FormSection({ subject }: { subject: Subject }): React.ReactElement {
  return (
    <section className="sp-section sp-dp-form">
      <h2 className="sp-dp-title">
        <code className="sp-dp-form-name">{subject.form}</code>
        {subject.purpose}
      </h2>
      <p className="sp-dp-verdict">{subject.verdict}</p>

      <TugLabel size="2xs" emphasis="calm">Today</TugLabel>
      <TodayFigure spec={subject.today} />

      <TugLabel size="2xs" emphasis="calm">Plus</TugLabel>
      <PlusFigure spec={subject.plus} />

      <ol className="sp-dp-notes">
        {subject.notes.map((note, i) => (
          <NoteRow key={note.title} n={i + 1} note={note} />
        ))}
      </ol>
    </section>
  );
}

function SpikeDiagramPlus(): React.ReactElement {
  return (
    <div className="sp-content">
      <section className="sp-section">
        <h2 className="sp-section-title">Diagram Plus — four forms, each made to say more</h2>
        <TugLabel size="2xs" emphasis="calm">
          Each form below is drawn twice from one subject: as it ships, and with the numbered changes applied. A
          change is tagged look (the shared pen), layout (the form) or spec (a new field for the author). The ones
          marked not drawn are proposals only.
        </TugLabel>
        <div className="sp-dp-common">
          <span className="sp-dp-common-title">One connector for all four forms</span>
          <p className="sp-dp-note-body">
            Every change to an arrow below is the same change. A connector is 2 px in full ink where today it is
            1.5 px in muted ink; its head is 11 px long where today it is 8; and what it carries is written in a
            chip that sits on the line, never beside it or under it. A tone recolours the line, the head and the
            chip together. That is a change to the pen (`diagram/pen.rs`), so the forms inherit it.
          </p>
        </div>
      </section>

      {SUBJECTS.map((subject) => (
        <FormSection key={subject.form} subject={subject} />
      ))}
    </div>
  );
}

export const spike: SpikeDef = {
  name: "diagram-plus",
  title: "Diagram Plus",
  blurb: "What would make each /explain diagram form say more, and say it more clearly?",
  icon: "Workflow",
  size: {
    min: { width: 560, height: 400 },
    preferred: { width: 1120, height: 900 },
  },
  component: () => <SpikeDiagramPlus />,
};
