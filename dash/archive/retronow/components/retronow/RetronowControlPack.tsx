"use client";

import { ArrowLeft, ArrowRight, ChevronsUpDown, RefreshCw, Star } from "lucide-react";
import { useMemo, useState } from "react";

import { retronow } from "./retronow-classes";

/*
  This is a style pack example for shadcn stacks.
  Swap native elements below for your shadcn primitives and keep the same class names.
*/
export function RetronowControlPack() {
  const [slider, setSlider] = useState(62);
  const modeLabel = useMemo(() => (slider > 75 ? "Autonomous" : slider > 45 ? "Assisted" : "Manual"), [slider]);

  return (
    <section className={`${retronow.shell} p-4`}>
      <div className="mb-2 flex items-center gap-2 border-b border-[#a29b8a] bg-[linear-gradient(180deg,#67747d_0%,#5f6c75_100%)] px-2 py-1 text-white">
        <span className="h-2.5 w-2.5 rounded-full border border-[#122029] bg-[#c56457]" />
        <span className="h-2.5 w-2.5 rounded-full border border-[#122029] bg-[#d7a156]" />
        <span className="h-2.5 w-2.5 rounded-full border border-[#122029] bg-[#8db480]" />
        <strong className="ml-2 font-mono text-xs uppercase tracking-[0.08em]">Retronow Controls</strong>
      </div>

      <div className="mb-3 grid grid-cols-[auto_auto_1fr_auto] gap-2 rounded-[4px] border border-[#a29b8a] bg-[#c8c1af] p-2">
        <button className={retronow.buttonSecondary} aria-label="Back">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button className={retronow.buttonSecondary} aria-label="Forward">
          <ArrowRight className="h-4 w-4" />
        </button>
        <input className={retronow.input} defaultValue="https://control.retronow.local/deck/alpha" />
        <button className={retronow.buttonSecondary} aria-label="Refresh">
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className={`${retronow.panel} space-y-3`}>
          <h3 className={retronow.title}>Text + Selectors</h3>
          <div className="space-y-1">
            <label className={retronow.title} htmlFor="rn-name">
              Single-line field
            </label>
            <input id="rn-name" className={retronow.input} placeholder="Station identifier" />
          </div>
          <div className="space-y-1">
            <label className={retronow.title} htmlFor="rn-notes">
              Multiline text area
            </label>
            <textarea id="rn-notes" className={retronow.textarea} defaultValue={"Deck notes\n- card snap is active\n- edge magnetism enabled"} />
          </div>
          <div className="space-y-1">
            <label className={retronow.title} htmlFor="rn-combo">
              Combo box
            </label>
            <div className="flex items-center gap-2">
              <select id="rn-combo" className={`${retronow.input} min-w-[200px]`}>
                <option>Primary circuit</option>
                <option>Auxiliary line</option>
                <option>Remote uplink</option>
              </select>
              <button className={retronow.buttonSecondary} aria-label="Open options">
                <ChevronsUpDown className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        <div className={`${retronow.panel} space-y-3`}>
          <h3 className={retronow.title}>Actions + Instruments</h3>
          <div className="flex flex-wrap items-center gap-2">
            <button className={retronow.button}>Primary Action</button>
            <button className={retronow.buttonSecondary}>Secondary</button>
            <button className={retronow.buttonSecondary} aria-label="Favorite">
              <Star className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-1">
            <label className={retronow.title} htmlFor="rn-slider">
              Slider: {slider}%
            </label>
            <input
              id="rn-slider"
              className="w-full accent-[#d9b25e]"
              type="range"
              min={0}
              max={100}
              value={slider}
              onChange={(e) => setSlider(Number(e.target.value))}
            />
          </div>
          <fieldset className="space-y-1">
            <legend className={retronow.title}>Radio set</legend>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                <input type="radio" name="mode" defaultChecked />
                Manual
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="mode" />
                Assisted
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="mode" />
                Autonomous
              </label>
            </div>
          </fieldset>
          <label className="flex items-center gap-2">
            <input type="checkbox" defaultChecked />
            <span>Enable anomaly detection ({modeLabel})</span>
          </label>
        </div>
      </div>
    </section>
  );
}
