/**
 * gallery-atom.tsx -- the whole atom family, in one place.
 *
 * **The registers lead, and the live pill stands beside the baked chip.** That
 * pairing is the point of the page rather than a nicety: an atom is drawn by
 * three renderers — an inline `<svg>`, a Canvas → PNG bake, and the live CSS
 * pill a session citation is — and for a long time each derived its own box
 * from whatever host it landed in. One session atom stood 18px tall in the
 * composer, 20px in the transcript, 21px in an Overview post and 25px in the
 * Changes shade, and it stayed invisible because this card showed the bakes and
 * `gallery-arc-lifecycle` showed the pills and nothing showed them together.
 * Now they read from one table (`lib/atom-register.ts`) and this row is where a
 * reader can see that they do.
 *
 * The rest of the page is the bake's own business: every type, label
 * formatting, truncation, and inline flow through prose.
 *
 * Atoms are rendered via createAtomImgElement from tug-atom-img.ts —
 * the same path used by TugTextEngine inside contentEditable.
 */

import React, { useId, useRef, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  createAtomImgElement,
  formatAtomLabel,
} from "@/lib/tug-atom-img";
import type { AtomSegment, AtomLabelMode } from "@/lib/tug-atom-img";
import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import type { TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import "./gallery-atom.css";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TugAtomChip } from "@/lib/tug-atom-chip";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import {
  ATOM_REGISTERS,
  atomRegisterMetrics,
  atomRegisterVars,
  type AtomRegister,
} from "@/lib/atom-register";
import { composeSessionIdentity } from "@/lib/session-identity";

// ---- Sample data ----

const SAMPLE_ATOMS: AtomSegment[] = [
  { kind: "atom", type: "file", label: "main.ts", value: "/Users/kocienda/project/src/main.ts" },
  { kind: "atom", type: "file", label: "feed-store.ts", value: "/Users/kocienda/project/src/lib/feed-store.ts" },
  { kind: "atom", type: "command", label: "/commit", value: "/commit" },
  { kind: "atom", type: "doc", label: "tuglaws.md", value: "/Users/kocienda/project/tuglaws/tuglaws.md" },
  { kind: "atom", type: "image", label: "screenshot.png", value: "/Users/kocienda/Desktop/screenshot.png" },
  { kind: "atom", type: "link", label: "anthropic.com", value: "https://www.anthropic.com/research" },
];

const LONG_LABEL_ATOMS: AtomSegment[] = [
  { kind: "atom", type: "file", label: "very-long-component-name-that-should-truncate.tsx", value: "very-long-component-name-that-should-truncate.tsx" },
  { kind: "atom", type: "doc", label: "architecture-decisions-and-design-patterns.md", value: "architecture-decisions-and-design-patterns.md" },
  { kind: "atom", type: "link", label: "https://www.anthropic.com/research/very/long/path/to/resource", value: "https://www.anthropic.com/research/very/long/path/to/resource" },
];

const LABEL_MODE_CHOICES: TugChoiceItem[] = [
  { value: "filename", label: "Filename" },
  { value: "relative", label: "Relative" },
  { value: "absolute", label: "Absolute" },
];

// ---- Helpers ----

/** Render atoms into a container element via direct DOM writes [L06]. */
function renderAtoms(
  container: HTMLElement,
  atoms: AtomSegment[],
  options?: Parameters<typeof createAtomImgElement>[3],
) {
  container.textContent = "";
  for (const seg of atoms) {
    const img = createAtomImgElement(seg.type, seg.label, seg.value, options);
    img.style.marginRight = "8px";
    img.style.marginBottom = "4px";
    container.appendChild(img);
  }
}

/** One resolved session, so the live pill has something to name. */
const GALLERY_IDENTITY = composeSessionIdentity({
  sessionId: "b3c4d5e6-1a2b-4c3d-8e4f-5a6b7c8d9e02",
  name: null,
  synopsis: null,
  tag: "brisk-lantern",
  projectDir: "/Users/tester/src/tugtool",
});

/** The kinds a register is shown across — one of each family, plus a session. */
const REGISTER_ATOMS: AtomSegment[] = [
  { kind: "atom", type: "file", label: "main.ts", value: "/src/main.ts" },
  { kind: "atom", type: "doc", label: "tuglaws.md", value: "/tuglaws/tuglaws.md" },
  { kind: "atom", type: "image", label: "screenshot.png", value: "/Desktop/screenshot.png" },
  { kind: "atom", type: "command", label: "/commit", value: "/commit" },
  { kind: "atom", type: "link", label: "anthropic.com", value: "https://www.anthropic.com" },
];

/**
 * One register's whole family, on a host that publishes it.
 *
 * The host publishes {@link atomRegisterVars} exactly as a transcript body or a
 * arc block does, so the pill inside is sized by the same numbers the chips
 * beside it are measured with — and a divergence shows up here as two heights
 * in one row, which is the only way this class of defect is ever visible.
 */
function RegisterRow({ register }: { register: AtomRegister }): React.ReactElement {
  const m = atomRegisterMetrics(register);
  return (
    <div className="gallery-atom-register" data-register={register}>
      <div className="gallery-atom-register-caption">
        {register} — {m.height}px box · {m.fontSize}px type · {m.dotSize}px dot
      </div>
      <div
        className="gallery-atom-row"
        style={atomRegisterVars(register) as React.CSSProperties}
      >
        {REGISTER_ATOMS.map((seg) => (
          <TugAtomChip
            key={seg.type}
            className="tug-atom-chip"
            type={seg.type}
            label={seg.label}
            value={seg.value}
            register={register}
          />
        ))}
        <TugSessionIdentity
          identity={GALLERY_IDENTITY}
          tier="chip"
          register={register}
          tooltip={false}
        />
      </div>
    </div>
  );
}

const descStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  marginBottom: "4px",
};

// ---- Gallery component ----

export function GalleryAtom() {
  const typesRef = useRef<HTMLDivElement>(null);
  const truncRef = useRef<HTMLDivElement>(null);
  const inlineRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const [labelMode, setLabelMode] = useState<AtomLabelMode>("filename");
  /* The running-text sample's host for the LIVE pill — created by the same
     imperative pass that appends the baked chips, so the pill stands in the
     sentence's own inline flow rather than beside it. That flow is the only
     place the baseline claim can be read: `vertical-align` does nothing in the
     flex rows above, so a pill hanging off its phase dot instead of its label
     looked identical up there and wrong down here. */
  const [pillHost, setPillHost] = useState<HTMLSpanElement | null>(null);

  // All types [L06]
  useLayoutEffect(() => {
    if (typesRef.current) renderAtoms(typesRef.current, SAMPLE_ATOMS);
  }, []);

  // Truncation [L06]
  useLayoutEffect(() => {
    if (truncRef.current) renderAtoms(truncRef.current, LONG_LABEL_ATOMS, { maxLabelWidth: 150 });
  }, []);

  // Inline with text [L06]
  useLayoutEffect(() => {
    const el = inlineRef.current;
    if (!el) return;
    el.textContent = "";
    const parts: Array<string | AtomSegment> = [
      "Please review the changes in ",
      { kind: "atom", type: "file", label: "main.ts", value: "/src/main.ts" },
      " and run ",
      { kind: "atom", type: "command", label: "/commit", value: "/commit" },
      " when ready. See ",
      { kind: "atom", type: "link", label: "anthropic.com", value: "https://www.anthropic.com" },
      " for more details.",
    ];
    for (const part of parts) {
      if (typeof part === "string") {
        el.appendChild(document.createTextNode(part));
      } else {
        el.appendChild(createAtomImgElement(part.type, part.label, part.value));
      }
    }
    // …and the live pill, last, in the same sentence: the one atom of the
    // family that is a subscribed component rather than a drawing of one.
    //
    // It stands inside a nowrap span with a baked chip beside it, and that
    // pairing is the point: the two renderers align by two different routes
    // and only a shared LINE can show that they arrive at the same place. A
    // wrap between them would put the comparison on two lines and quietly
    // make it meaningless.
    el.appendChild(document.createTextNode(" Asked of "));
    const pair = document.createElement("span");
    pair.dataset.slot = "gallery-atom-inline-pair";
    pair.style.whiteSpace = "nowrap";
    pair.appendChild(
      createAtomImgElement("file", "deck-manager.ts", "/src/deck-manager.ts"),
    );
    pair.appendChild(document.createTextNode(" by "));
    const host = document.createElement("span");
    host.dataset.slot = "gallery-atom-inline-pill";
    pair.appendChild(host);
    el.appendChild(pair);
    el.appendChild(document.createTextNode("."));
    setPillHost(host);
  }, []);

  // Label modes [L06]
  useLayoutEffect(() => {
    const el = labelRef.current;
    if (!el) return;
    el.textContent = "";
    const fileAtoms = SAMPLE_ATOMS.filter(s => s.type === "file" || s.type === "doc");
    for (const seg of fileAtoms) {
      const displayLabel = formatAtomLabel(seg.value, labelMode);
      const img = createAtomImgElement(seg.type, displayLabel, seg.value);
      img.style.marginRight = "8px";
      img.style.marginBottom = "4px";
      el.appendChild(img);
    }
  }, [labelMode]);

  // L11 migration via useResponderForm — the label mode choice group
  // dispatches `selectValue`. Its gensym'd sender id is bound to a
  // wrapper setter that casts the string payload to AtomLabelMode.
  const labelModeId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      [labelModeId]: (v: string) => setLabelMode(v as AtomLabelMode),
    },
  });

  return (
    <ResponderScope>
    <div
      className="cg-content"
      data-testid="gallery-atom"
      ref={responderRef as (el: HTMLDivElement | null) => void}
    >

      {/* ---- The registers, with the live pill beside the baked chips ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Registers</TugLabel>
        <div style={descStyle}>
          Every kind at every register, and the live session pill last in each
          row — it must be the same height as the chips beside it, because they
          are drawn from one table. `prose` is an atom in a line of running
          text; `reading` is one in a block at reading scale.
        </div>
        {(Object.keys(ATOM_REGISTERS) as AtomRegister[]).map((register) => (
          <RegisterRow key={register} register={register} />
        ))}
      </div>

      <TugSeparator />

      {/* ---- All known types ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Atom Types</TugLabel>
        <div ref={typesRef} className="gallery-atom-row" />
      </div>

      <TugSeparator />

      {/* ---- Inline with text ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Inline with Text</TugLabel>
        <div
          ref={inlineRef}
          className="gallery-atom-text-sample"
          style={atomRegisterVars("prose") as React.CSSProperties}
        />
        {pillHost
          ? createPortal(
              <TugSessionIdentity
                identity={GALLERY_IDENTITY}
                tier="chip"
                register="prose"
                tooltip={false}
              />,
              pillHost,
            )
          : null}
      </div>

      <TugSeparator />

      {/* ---- Truncation ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Truncation</TugLabel>
        <div style={descStyle}>Labels truncated to 150px with ellipsis</div>
        <div ref={truncRef} className="gallery-atom-row" />
      </div>

      <TugSeparator />

      {/* ---- Label modes ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Label Modes</TugLabel>
        <TugChoiceGroup
          items={LABEL_MODE_CHOICES}
          value={labelMode}
          senderId={labelModeId}
          size="sm"
        />
        <div ref={labelRef} className="gallery-atom-row" style={{ marginTop: "8px" }} />
      </div>

    </div>
    </ResponderScope>
  );
}
