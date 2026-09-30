/**
 * gallery-theme-editor.tsx — the Theme Deriver.
 *
 * Two distinct jobs, kept in two separate regions so they never blur together:
 *
 *  1. SET A BASE (ironclad dark / sloop light). A base is hand-authored, not
 *     derived. Its identity is its Key color — the vivid chip / toggle fill. This
 *     region lets you set that color EXPLICITLY in the picker (hue + chroma +
 *     lightness); applying scales the whole Key ramp so its anchor token lands on
 *     the chosen color, keeping the ramp's shape. This is where you make the key
 *     less hot / less bright.
 *  2. DERIVE A FAMILY MEMBER from a base by rotating its Key/Accent brand hues,
 *     holding each token's PERCEIVED chroma + lightness (theme-editor-core's
 *     deriveTheme). Pick the member, choose target hues, audition, Generate.
 *
 * The two never share a chooser: bases live in their own region, derived themes
 * in theirs. Both write via the dev-server /__theme-editor/derive endpoint. The
 * base CSS is imported raw (?raw, never expanded) so deriveTheme runs in-browser
 * for the live audition — no server round-trip until you commit.
 *
 * Laws:
 *  - [L11] controls emit actions; the card handles them via useResponder.
 *  - [L19] gallery-card authoring; registered in gallery-registrations.tsx.
 *  - [P02] the controls are authored into one focus group.
 */

import React, { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import { TugColorWell } from "@/components/tugways/tug-color-well";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TugBox } from "@/components/tugways/tug-box";
import { useResponder } from "@/components/tugways/use-responder";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { useFocusManager } from "@/components/tugways/use-focusable";
import { useSpatialOrder } from "@/components/tugways/use-spatial-order";
import { rowGridOrder, type SpatialOrder } from "@/components/tugways/spatial-order";
import { CardIdContext } from "@/lib/card-id-context";
import { setActiveColorTarget } from "@/components/tugways/active-color-target";
import { type TugColorSpec } from "@/components/tugways/tugcolor";
import { HUE_FAMILIES, fracFromAuthored, chromaFromAuthored, resolveHueAngle } from "@/components/tugways/tugcolor";
import { deriveTheme } from "../../../../theme-editor-core";
import { TUG_ACTIONS } from "../action-vocabulary";
import ironcladRaw from "../../../../styles/themes/ironclad.css?raw";
import sloopRaw from "../../../../styles/themes/sloop.css?raw";
import "./gallery.css";
import "./gallery-theme-editor.css";

// ---------------------------------------------------------------------------
// Bases and the derived family.
// ---------------------------------------------------------------------------

type BaseName = "ironclad" | "sloop";

const BASE_CSS: Record<BaseName, string> = { ironclad: ironcladRaw, sloop: sloopRaw };

const BASE_ITEMS: Array<{ value: BaseName; label: string }> = [
  { value: "ironclad", label: "Ironclad (dark)" },
  { value: "sloop", label: "Sloop (light)" },
];

/** The token whose color IS the base's key color — the vivid filled-action fill
 *  (matches ANCHOR_KEY_TOKEN in theme-editor-core, which scales the ramp to it). */
const ANCHOR_KEY_TOKEN = "--tug7-surface-control-primary-filled-action-rest";

interface FamilyEntry { base: BaseName; mode: "dark" | "light"; key: string; accent: string; }

const FAMILY: Record<string, FamilyEntry> = {
  caravel: { base: "ironclad", mode: "dark", key: "seafoam", accent: "orange" },
  barque: { base: "ironclad", mode: "dark", key: "purple", accent: "orange" },
  galleon: { base: "ironclad", mode: "dark", key: "cerulean", accent: "orange" },
  collier: { base: "ironclad", mode: "dark", key: "rose", accent: "orange" },
  ketch: { base: "sloop", mode: "light", key: "iris", accent: "orange" },
  skiff: { base: "sloop", mode: "light", key: "seafoam", accent: "orange" },
  kayak: { base: "sloop", mode: "light", key: "sapphire", accent: "orange" },
  pinnace: { base: "sloop", mode: "light", key: "rose", accent: "orange" },
};

const OUTPUT_ITEMS = Object.keys(FAMILY).map((name) => ({
  value: name,
  label: name[0].toUpperCase() + name.slice(1),
}));

/** Representative tokens shown as an audition of a theme. */
const PREVIEW: ReadonlyArray<readonly [string, string]> = [
  ["Filled", "--tug7-surface-control-primary-filled-action-rest"],
  ["Tinted", "--tug7-surface-control-primary-tinted-action-rest"],
  ["Selection", "--tug7-surface-selection-primary-normal-selected-rest"],
  ["Link", "--tug7-element-global-text-normal-link-rest"],
  ["Accent", "--tug7-element-global-fill-normal-accent-rest"],
  ["Surface", "--tug7-surface-global-primary-normal-content-rest"],
];

const angle = (hue: string): string => {
  const a = HUE_FAMILIES[hue];
  return a === undefined ? "" : `${a}°`;
};

/** Parse a token's `--tug-color(...)` into a spec (single-hue tokens; a light
 *  parse suffices for both the audition and reading a base's current key color). */
function tokenSpec(css: string, name: string): TugColorSpec | null {
  const m = new RegExp(`${name}\\s*:\\s*--tug-color\\(([^)]*)\\)`).exec(css);
  if (!m) return null;
  const parts = m[1].split(",").map((s) => s.trim());
  const [hue, adjacent] = parts[0].split("-");
  // Collect raw authored ints first — chroma is absolute but gamut-clamped once L is known.
  let lRaw: number | undefined, cRaw = 0, aRaw: number | undefined;
  for (const p of parts.slice(1)) {
    const mm = p.match(/^([lca])\s*:\s*([\d.]+)$/);
    if (!mm) continue;
    const v = parseFloat(mm[2]);
    if (mm[1] === "l") lRaw = v;
    else if (mm[1] === "c") cRaw = v;
    else aRaw = v;
  }
  const l = lRaw === undefined ? 0.5 : fracFromAuthored(lRaw);
  const angle = resolveHueAngle(hue, adjacent);
  const c = angle === undefined ? 0 : chromaFromAuthored(cRaw, l, angle);
  const a = aRaw === undefined ? 1 : fracFromAuthored(aRaw);
  return { hue, adjacent, l, c, a };
}

/** A base's current key color, read from its anchor token. */
function baseKeyColor(base: BaseName): TugColorSpec {
  return tokenSpec(BASE_CSS[base], ANCHOR_KEY_TOKEN) ?? { hue: "cobalt", l: 0.5, c: 0.14, a: 1 };
}

// ---------------------------------------------------------------------------
// GalleryThemeEditor — the Theme Deriver
// ---------------------------------------------------------------------------

export function GalleryThemeEditor(): React.ReactElement {
  // ---- Region 1: set a base ----
  const [baseSel, setBaseSel] = useState<BaseName>("ironclad");
  // The well holds the base's key color directly; the picker edits hue + absolute
  // chroma/lightness, and applying anchors the whole Key ramp to it.
  const [baseKey, setBaseKey] = useState<TugColorSpec>(() => baseKeyColor("ironclad"));
  const [baseBusy, setBaseBusy] = useState(false);
  const [baseMsg, setBaseMsg] = useState<string | null>(null);

  // ---- Region 2: derive a family member ----
  const [output, setOutput] = useState<string>("caravel");
  const fam = FAMILY[output];
  // These wells only contribute their HUE — derivation rotates by hue and holds
  // each token's own perceived chroma + lightness.
  const [keySpec, setKeySpec] = useState<TugColorSpec>({ hue: fam.key, l: 0.5, c: 0.12, a: 1 });
  const [accSpec, setAccSpec] = useState<TugColorSpec>({ hue: fam.accent, l: 0.5, c: 0.12, a: 1 });
  const [derivedBusy, setDerivedBusy] = useState(false);
  const [derivedMsg, setDerivedMsg] = useState<string | null>(null);
  const keyHue = keySpec.hue;
  const accHue = accSpec.hue;

  // On base switch, load that base's current key color into the well.
  useEffect(() => {
    setBaseKey(baseKeyColor(baseSel));
  }, [baseSel]);

  // On family switch, reset the hues to that member's defaults.
  useEffect(() => {
    setKeySpec({ hue: FAMILY[output].key, l: 0.5, c: 0.12, a: 1 });
    setAccSpec({ hue: FAMILY[output].accent, l: 0.5, c: 0.12, a: 1 });
  }, [output]);

  // Base audition — derive the base onto itself with the explicit key color.
  const baseAnchor = useMemo(() => ({ c: baseKey.c, l: baseKey.l }), [baseKey]);
  const basePreview = useMemo(() => {
    const { css } = deriveTheme(BASE_CSS[baseSel], baseKey.hue, undefined, baseAnchor);
    return PREVIEW.map(([label, name]) => [label, tokenSpec(css, name)] as const);
  }, [baseSel, baseKey.hue, baseAnchor]);

  // Derived audition — rotate hues, hold C/L.
  const derivedPreview = useMemo(() => {
    const { css } = deriveTheme(BASE_CSS[fam.base], keyHue, accHue);
    return PREVIEW.map(([label, name]) => [label, tokenSpec(css, name)] as const);
  }, [fam.base, keyHue, accHue]);

  const responderId = useId();
  const baseSelId = useId();
  const baseKeyWellId = useId();
  const outputId = useId();
  const keyWellId = useId();
  const accWellId = useId();

  // ---- Focus language ([P02]) — one group, a flat vertical order so arrows
  // never dead-end into a beep (choice groups own their own Left/Right). ----
  const FG = useId();
  const focusManager = useFocusManager();
  const cardId = useContext(CardIdContext);
  const spatialOrder = useMemo<SpatialOrder>(
    () => rowGridOrder([0, 1, 2, 3, 4, 5, 6].map((n) => [`${FG}:${n}`])),
    [FG],
  );
  useSpatialOrder(spatialOrder);
  const seededRef = useRef(false);
  useLayoutEffect(() => {
    if (!focusManager) return;
    const arm = (): void => {
      if (seededRef.current) return;
      if (cardId !== null && focusManager.keyCard() !== cardId) return;
      seededRef.current = true;
      focusManager.place(cardId, { kind: "focus-key", focusKey: `${FG}:0` }, { modality: "keyboard" });
    };
    arm();
    return focusManager.subscribe(arm);
  }, [focusManager, cardId, FG]);

  const { ResponderScope, responderRef } = useResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.ACTIVATE_COLOR_WELL]: (e: ActionEvent) => {
        const sender = typeof e.sender === "string" ? e.sender : "";
        const payload = e.value as { value: TugColorSpec; label: string } | undefined;
        if (!sender || !payload) return;
        setActiveColorTarget({ targetId: responderId, senderId: sender, label: payload.label, value: payload.value });
      },
      [TUG_ACTIONS.SET_COLOR]: (e: ActionEvent) => {
        const sender = typeof e.sender === "string" ? e.sender : "";
        const next = e.value as TugColorSpec | undefined;
        if (!sender || !next) return;
        if (sender === baseKeyWellId) setBaseKey(next);
        else if (sender === keyWellId) setKeySpec(next);
        else if (sender === accWellId) setAccSpec(next);
      },
      [TUG_ACTIONS.SELECT_VALUE]: (e: ActionEvent) => {
        if (typeof e.value !== "string") return;
        if (e.sender === baseSelId) setBaseSel(e.value as BaseName);
        else if (e.sender === outputId) setOutput(e.value);
      },
    },
  });

  const onUpdateBase = (): void => {
    setBaseBusy(true);
    setBaseMsg(null);
    fetch("/__theme-editor/derive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base: baseSel, out: baseSel, keyHue: baseKey.hue, keyAnchor: baseAnchor }),
    })
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as { error?: string; count?: number };
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
        setBaseMsg(`Updated ${baseSel} — key set to ${baseKey.hue}, ${data.count ?? 0} tokens`);
      })
      .catch((err: unknown) => setBaseMsg(`Failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBaseBusy(false));
  };

  const onGenerate = (): void => {
    setDerivedBusy(true);
    setDerivedMsg(null);
    fetch("/__theme-editor/derive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base: fam.base, out: output, keyHue, accentHue: accHue }),
    })
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as { error?: string; count?: number };
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
        setDerivedMsg(`Generated ${output} from ${fam.base} — ${data.count ?? 0} tokens`);
      })
      .catch((err: unknown) => setDerivedMsg(`Failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setDerivedBusy(false));
  };

  return (
    <ResponderScope>
      <div className="cg-content" data-testid="gallery-theme-editor" ref={responderRef as (el: HTMLDivElement | null) => void}>
        {/* Region 1 — set a base ----------------------------------------- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Set a base</TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            A base is hand-authored, not derived. Set its key color explicitly — the
            whole Key ramp follows, keeping its shape.
          </TugLabel>

          <div className="gcd-controls">
            <div className="gcd-control-row">
              <span className="gcd-control-label">Base</span>
              <TugChoiceGroup
                items={BASE_ITEMS}
                value={baseSel}
                senderId={baseSelId}
                size="xs"
                aria-label="Base theme"
                commit="live"
                focusGroup={FG}
                focusOrder={0}
              />
            </div>
            <div className="gcd-control-row">
              <span className="gcd-control-label">Key color</span>
              <TugColorWell senderId={baseKeyWellId} label="Key color" value={baseKey} focusGroup={FG} focusOrder={1} />
              <span className="gcd-control-note">{baseKey.hue} ({angle(baseKey.hue)})</span>
            </div>
          </div>

          <TugBox variant="bordered" size="sm" className="gcd-preview-box">
            <div className="gcd-preview-grid">
              {basePreview.map(([label, spec]) => (
                <div key={label} className="gcd-preview-cell">
                  <span className="gcd-preview-label">{label}</span>
                  {spec ? <TugColorWell readOnly value={spec} size="sm" label={label} /> : <span className="gcd-control-note">—</span>}
                </div>
              ))}
            </div>
          </TugBox>

          <div className="gcd-actions" style={{ marginTop: "10px" }}>
            <TugPushButton emphasis="primary" role="action" size="xs" disabled={baseBusy} onClick={onUpdateBase} focusGroup={FG} focusOrder={2}>
              {baseBusy ? "Updating…" : `Update ${baseSel}`}
            </TugPushButton>
            {baseMsg && <TugLabel size="2xs" emphasis="calm">{baseMsg}</TugLabel>}
          </div>
        </div>

        <TugSeparator />

        {/* Region 2 — derive a family member ----------------------------- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Derive a theme</TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            Derive a family member from a base. Hues rotate; perceived chroma + lightness are held.
          </TugLabel>

          <div className="gcd-controls">
            <div className="gcd-control-row">
              <span className="gcd-control-label">Theme</span>
              <TugChoiceGroup
                items={OUTPUT_ITEMS}
                value={output}
                senderId={outputId}
                size="xs"
                aria-label="Family member"
                commit="live"
                focusGroup={FG}
                focusOrder={3}
              />
            </div>
            <div className="gcd-control-row">
              <span className="gcd-control-label">Base</span>
              <span className="gcd-control-note">{fam.base} ({fam.mode})</span>
            </div>
            <div className="gcd-control-row">
              <span className="gcd-control-label">Key hue</span>
              <TugColorWell senderId={keyWellId} label="Key hue" value={keySpec} focusGroup={FG} focusOrder={4} />
              <span className="gcd-control-note">{keyHue} ({angle(keyHue)})</span>
            </div>
            <div className="gcd-control-row">
              <span className="gcd-control-label">Accent hue</span>
              <TugColorWell senderId={accWellId} label="Accent hue" value={accSpec} focusGroup={FG} focusOrder={5} />
              <span className="gcd-control-note">{accHue} ({angle(accHue)})</span>
            </div>
          </div>

          <TugBox variant="bordered" size="sm" className="gcd-preview-box">
            <div className="gcd-preview-grid">
              {derivedPreview.map(([label, spec]) => (
                <div key={label} className="gcd-preview-cell">
                  <span className="gcd-preview-label">{label}</span>
                  {spec ? <TugColorWell readOnly value={spec} size="sm" label={label} /> : <span className="gcd-control-note">—</span>}
                </div>
              ))}
            </div>
          </TugBox>

          <div className="gcd-actions" style={{ marginTop: "10px" }}>
            <TugPushButton emphasis="primary" role="action" size="xs" disabled={derivedBusy} onClick={onGenerate} focusGroup={FG} focusOrder={6}>
              {derivedBusy ? "Generating…" : `Generate ${output}`}
            </TugPushButton>
            {derivedMsg && <TugLabel size="2xs" emphasis="calm">{derivedMsg}</TugLabel>}
          </div>
        </div>
      </div>
    </ResponderScope>
  );
}
