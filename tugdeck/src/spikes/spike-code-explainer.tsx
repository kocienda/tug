/**
 * spike-code-explainer.tsx — can a closed set of diagram forms explain code
 * as well as a figure drawn by hand?
 *
 * A code explainer is a figure and a keyed table: the figure shows one flow
 * through the code, and each numbered mark in it has a row beneath saying
 * what it does and where it is. The proposal is a `tugdiagram` spec beside
 * `tugchart`, compiled by the same crate to the same layer 0 drawing
 * language, where the author gives names, relations and order and a form
 * gives every coordinate.
 *
 * This spike is where the forms' layouts and looks are decided. It draws
 * four subjects through three prototype forms (`flow`, `sequence`,
 * `layers`), each compiled to a real layer 0 program and rendered by the
 * real engine, so colour, type and entrances are the shipping ones. The
 * first subject is the figure the idea came from, restated as a spec.
 *
 * What to judge:
 *
 *  - **Routing.** Square elbows, rounded elbows, or one curve per forward
 *    edge.
 *  - **Fill.** A box that holds rows tinted in the accent, or every box
 *    plain.
 *  - **Keys.** The number inline before the name, or on a disc.
 *  - **The unit.** Title, figure, caption, lead, keyed table — whether that
 *    stack is the explainer.
 *
 * The line under each figure reports the frame, the op count and how many
 * times edges cross. A shipping form would refuse a figure over a crossing
 * bar instead of drawing it.
 *
 * Nothing here ships. The forms are TypeScript in
 * `spike-code-explainer-layout.ts` so they can be changed without a WASM
 * build; what survives is ported to Rust beside the chart forms.
 *
 * @module spikes/spike-code-explainer
 */

import "./spike.css";
import "@/components/tugways/body-kinds/chart-block.css";
import "./spike-code-explainer.css";

import React, { useId, useLayoutEffect, useRef, useState } from "react";

import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { awaitRoleFaces, ensureRoleProbes, probeMeasurer, roleFacesLoaded } from "@/lib/chart/chart-measure";
import { loadTuggraphics } from "@/lib/lazy/load-tuggraphics";

import { layoutDiagram, legendOf, type DiagramSpec, type Look, type Routing } from "./spike-code-explainer-layout";
import { SUBJECTS, type Subject } from "./spike-code-explainer-subjects";
import type { SpikeDef } from "./spike-registry";

/** Text with an ascender, a descender and digits, to ask the faces for. */
const FACE_SAMPLE = "Hamburgefonstiv 0123";

let figureSeq = 0;

/**
 * Lays a spec out and renders it into `body`. Everything it writes is DOM:
 * the SVG, the entrance attribute, and the reading under the figure.
 */
async function drawInto(
  root: HTMLElement,
  body: HTMLElement,
  readout: HTMLElement,
  spec: DiagramSpec,
  look: Look,
  live: () => boolean,
): Promise<void> {
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
    const drawn = layoutDiagram(spec, look, measure);
    const out = engine.render_program(drawn.program, `spce${++figureSeq}`);
    if (out.status === "done") {
      root.toggleAttribute("data-tugx-chart-animate", look.motion);
      // The engine's own SVG, built from a validated program: no author text reaches it as markup.
      body.innerHTML = out.svg;
      reading = `${spec.form} · ${drawn.width} × ${drawn.height} · ${drawn.ops} ops · ${drawn.crossings} crossing${drawn.crossings === 1 ? "" : "s"}`;
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

function Figure({ spec, look, replay }: { spec: DiagramSpec; look: Look; replay: number }): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const body = bodyRef.current;
    const readout = readoutRef.current;
    if (root === null || body === null || readout === null) return;
    let alive = true;
    void drawInto(root, body, readout, spec, look, () => alive);
    return () => {
      alive = false;
    };
  }, [spec, look, replay]);

  return (
    <div>
      <div className="tugx-chart sp-ce-figure" data-tugx-chart-state="rendered" ref={rootRef}>
        <div className="tugx-chart-body" ref={bodyRef} />
      </div>
      <div className="sp-ce-readout" ref={readoutRef} />
    </div>
  );
}

function Explainer({ n, subject, look, replay }: { n: number; subject: Subject; look: Look; replay: number }): React.ReactElement {
  const legend = legendOf(subject.spec).filter((row) => row.does !== "");
  return (
    <section className="sp-section sp-ce-explainer">
      <h2 className="sp-ce-title">
        <span className="sp-ce-title-n">{String(n).padStart(2, "0")}</span>
        {subject.title}
      </h2>
      <Figure spec={subject.spec} look={look} replay={replay} />
      <p className="sp-ce-caption">{subject.caption}</p>
      <p className="sp-ce-lead">{subject.lead}</p>
      {legend.length > 0 ? (
        <table className="sp-ce-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Step</th>
              <th>What it does</th>
              <th>Where it is</th>
            </tr>
          </thead>
          <tbody>
            {legend.map((row) => (
              <tr key={row.key}>
                <td className="sp-ce-key">{row.key}</td>
                <td className="sp-ce-name">{row.name}</td>
                <td>{row.does}</td>
                <td>
                  <code className="sp-ce-where">{row.where}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

const ROUTING_ITEMS = [
  { value: "elbow", label: "Elbow" },
  { value: "rounded", label: "Rounded" },
  { value: "curve", label: "Curve" },
];
const FILL_ITEMS = [
  { value: "tinted", label: "Tinted" },
  { value: "plain", label: "Plain" },
];
const KEY_ITEMS = [
  { value: "inline", label: "Inline" },
  { value: "disc", label: "Disc" },
];

function SpikeCodeExplainer(): React.ReactElement {
  const [routing, setRouting] = useState<string>("rounded");
  const [fill, setFill] = useState<string>("tinted");
  const [keys, setKeys] = useState<string>("inline");
  const [replay, setReplay] = useState(0);

  const routingId = useId();
  const fillId = useId();
  const keysId = useId();

  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      [routingId]: setRouting,
      [fillId]: setFill,
      [keysId]: setKeys,
    },
  });

  const look = React.useMemo<Look>(
    () => ({
      routing: routing as Routing,
      fill: fill === "plain" ? "plain" : "tinted",
      keys: keys === "disc" ? "disc" : "inline",
      motion: true,
    }),
    [routing, fill, keys],
  );

  return (
    <ResponderScope>
      <div className="sp-content" ref={responderRef as (el: HTMLDivElement | null) => void}>
        <section className="sp-section">
          <h2 className="sp-section-title">Code explainer — three forms, one look</h2>
          <TugLabel size="2xs" emphasis="calm">
            Every figure below is compiled from a spec with no coordinates in it to a layer 0 program, and drawn by
            the chart engine. Change the look for all four at once.
          </TugLabel>
          <div className="sp-ce-controls">
            <div className="sp-ce-control">
              <TugLabel size="2xs" emphasis="calm">Routing</TugLabel>
              <TugChoiceGroup items={ROUTING_ITEMS} value={routing} senderId={routingId} size="sm" />
            </div>
            <div className="sp-ce-control">
              <TugLabel size="2xs" emphasis="calm">Fill</TugLabel>
              <TugChoiceGroup items={FILL_ITEMS} value={fill} senderId={fillId} size="sm" />
            </div>
            <div className="sp-ce-control">
              <TugLabel size="2xs" emphasis="calm">Keys</TugLabel>
              <TugChoiceGroup items={KEY_ITEMS} value={keys} senderId={keysId} size="sm" />
            </div>
            <TugPushButton size="sm" onClick={() => setReplay((v) => v + 1)}>
              Replay entrance
            </TugPushButton>
          </div>
        </section>

        {SUBJECTS.map((subject, i) => (
          <Explainer key={subject.id} n={i + 1} subject={subject} look={look} replay={replay} />
        ))}
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "code-explainer",
  title: "Code Explainer",
  blurb: "Can a closed set of diagram forms explain code as well as a figure drawn by hand?",
  icon: "Workflow",
  size: {
    min: { width: 520, height: 400 },
    preferred: { width: 920, height: 900 },
  },
  component: () => <SpikeCodeExplainer />,
};
