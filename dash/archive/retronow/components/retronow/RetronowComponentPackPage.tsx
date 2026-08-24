"use client";

import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Move,
  RefreshCw,
  SlidersHorizontal,
  Star
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ArcGaugeCard } from "./ArcGaugeCard";
import { retronow } from "./retronow-classes";

type TabId = "controls" | "workspace" | "diagnostics" | "custom";

export function RetronowComponentPackPage() {
  const [activeTab, setActiveTab] = useState<TabId>("controls");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [slider, setSlider] = useState(54);
  const [mode, setMode] = useState("Assisted Mode");
  const [toast, setToast] = useState<string | null>(null);
  const [arcLo, setArcLo] = useState(0);
  const [arcValue, setArcValue] = useState(68400);
  const [arcHi, setArcHi] = useState(100000);
  const [arcEmptyWarning, setArcEmptyWarning] = useState(10);
  const [arcFullWarning, setArcFullWarning] = useState(90);
  const [arcScale, setArcScale] = useState(100);
  const [arcMajorTicks, setArcMajorTicks] = useState(11);
  const [arcMinorTicks, setArcMinorTicks] = useState(4);
  const [arcFormatUnit, setArcFormatUnit] = useState<"none" | "k" | "m" | "g">("k");
  const [arcDecimalDigits, setArcDecimalDigits] = useState(1);
  const [arcLabel, setArcLabel] = useState("THROUGHPUT");
  const [arcShowValue, setArcShowValue] = useState(true);
  const [arcShowPercent, setArcShowPercent] = useState(true);
  const [arcShowHiLo, setArcShowHiLo] = useState(true);
  const [arcShowGaugeLabel, setArcShowGaugeLabel] = useState(true);
  const [arcValueOrder, setArcValueOrder] = useState(1);
  const [arcPercentOrder, setArcPercentOrder] = useState(2);
  const [arcLabelOrder, setArcLabelOrder] = useState(3);
  const [arcValueScale, setArcValueScale] = useState(1);
  const [arcPercentScale, setArcPercentScale] = useState(1);
  const [arcLabelScale, setArcLabelScale] = useState(1);

  const sliderLabel = useMemo(() => `${slider}%`, [slider]);
  const sliderGauge = useMemo(() => `${Math.max(8, slider)}%`, [slider]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 1800);
    return () => window.clearTimeout(id);
  }, [toast]);

  return (
    <div className="retronow min-h-screen p-6">
      <div className="mx-auto max-w-[1280px]">
        <div className="rn-kicker">Retronow Component Pack</div>
        <h1 className="rn-title">Shadcn Wrapper Mockup in Action</h1>
        <p className="rn-subtitle">
          Demonstrates AppButton, AppInput, AppTextarea, AppSelect, AppTabs, AppDialog, AppSlider,
          and AppCardWindow behavior in the Retronow style.
        </p>

        <section className={retronow.shell}>
          <header className="rn-titlebar">
            <div className="rn-window-controls" aria-hidden="true">
              <span className="rn-control-dot" data-type="close" />
              <span className="rn-control-dot" data-type="min" />
              <span className="rn-control-dot" data-type="max" />
            </div>
            <strong className="rn-titlebar-label">AppTabs / AppCardWindow</strong>
          </header>

          <div className="rn-tabstrip" role="tablist" aria-label="Component tabs">
            <button className="rn-tab" data-state={activeTab === "controls" ? "active" : "inactive"} onClick={() => setActiveTab("controls")}>
              Controls
            </button>
            <button className="rn-tab" data-state={activeTab === "workspace" ? "active" : "inactive"} onClick={() => setActiveTab("workspace")}>
              Workspace
            </button>
            <button className="rn-tab" data-state={activeTab === "diagnostics" ? "active" : "inactive"} onClick={() => setActiveTab("diagnostics")}>
              Diagnostics
            </button>
            <button className="rn-tab" data-state={activeTab === "custom" ? "active" : "inactive"} onClick={() => setActiveTab("custom")}>
              Custom Gauges
            </button>
          </div>

          {activeTab === "controls" && (
            <section className="rn-main">
              <div className="rn-panel">
                <h2 className="rn-panel-title">AppInput / AppTextarea / AppSelect</h2>
                <div className="rn-grid">
                  <div>
                    <label className="rn-label" htmlFor="rn-app-input">
                      AppInput: address with subsidiary controls
                    </label>
                    <div className="rn-row">
                      <button className="rn-icon-btn" aria-label="Back">
                        <ArrowLeft size={16} />
                      </button>
                      <button className="rn-icon-btn" aria-label="Forward">
                        <ArrowRight size={16} />
                      </button>
                      <input id="rn-app-input" className="rn-field flex-1" defaultValue="https://retronow.local/card/1" />
                      <button className="rn-icon-btn" aria-label="Refresh">
                        <RefreshCw size={16} />
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="rn-label" htmlFor="rn-app-textarea">
                      AppTextarea
                    </label>
                    <textarea
                      id="rn-app-textarea"
                      className="rn-textarea"
                      defaultValue={"Mission notes:\n- docking guides enabled\n- audio alerts low\n- tabbed inspector online"}
                    />
                  </div>

                  <div>
                    <label className="rn-label" htmlFor="rn-app-select">
                      AppSelect (combo style)
                    </label>
                    <div className="rn-select-wrap">
                      <select
                        id="rn-app-select"
                        className="rn-combo"
                        value={mode}
                        onChange={(event) => setMode(event.target.value)}
                      >
                        <option>Manual Mode</option>
                        <option>Assisted Mode</option>
                        <option>Autonomous Mode</option>
                      </select>
                      <button className="rn-icon-btn" aria-label="Expand select">
                        <ChevronsUpDown size={16} />
                      </button>
                    </div>
                    <div className="rn-status-line">Mode: {mode}</div>
                  </div>
                </div>
              </div>

              <div className="rn-panel">
                <h2 className="rn-panel-title">AppButton / AppSlider / AppDialog</h2>
                <div className="rn-grid">
                  <div className="rn-row">
                    <button className="rn-button" onClick={() => setIsDialogOpen(true)}>
                      Open AppDialog
                    </button>
                    <button className="rn-button" data-variant="secondary" onClick={() => setToast("Snapshot saved to mission log")}>
                      Show Toast
                    </button>
                    <button className="rn-icon-btn" aria-label="Favorite">
                      <Star size={16} />
                    </button>
                  </div>

                  <div>
                    <label className="rn-label" htmlFor="rn-app-slider">
                      AppSlider
                    </label>
                    <div className="rn-meter">
                      <input
                        id="rn-app-slider"
                        className="rn-slider"
                        type="range"
                        min={0}
                        max={100}
                        value={slider}
                        onChange={(event) => setSlider(Number(event.target.value))}
                      />
                      <output className="rn-chip">{sliderLabel}</output>
                    </div>
                    <div className="rn-gauge mt-[10px]" aria-label="slider gauge">
                      <span style={{ width: sliderGauge }} />
                    </div>
                  </div>

                  <fieldset className="rn-grid">
                    <legend className="rn-label">AppRadioGroup + AppCheckbox</legend>
                    <div className="rn-switchgroup">
                      <label className="rn-control-row">
                        <input className="rn-radio" type="radio" name="power" defaultChecked />
                        Normal
                      </label>
                      <label className="rn-control-row">
                        <input className="rn-radio" type="radio" name="power" />
                        Boost
                      </label>
                      <label className="rn-control-row">
                        <input className="rn-radio" type="radio" name="power" />
                        Economy
                      </label>
                    </div>
                    <label className="rn-control-row">
                      <input className="rn-check" type="checkbox" defaultChecked />
                      <span>Enable deck auto-arrange</span>
                    </label>
                  </fieldset>
                </div>
              </div>
            </section>
          )}

          {activeTab === "workspace" && (
            <section className="rn-main">
              <div className="rn-canvas">
                <header className="rn-canvas-toolbar">
                  <button className="rn-button">New Card</button>
                  <button className="rn-button" data-variant="secondary">
                    Snap Layout
                  </button>
                  <span className="rn-badge">24px Grid</span>
                  <span className="rn-badge">Panel Docking</span>
                </header>
                <div className="rn-deck">
                  <article className="rn-card" data-size="md" style={{ left: 20, top: 16 }}>
                    <header className="rn-card-header">
                      Editor Card <Move size={14} />
                    </header>
                    <div className="rn-card-content">
                      <div className="rn-card-grid">
                        <div className="rn-mini" />
                        <div className="rn-mini" />
                        <div className="rn-mini" />
                        <div className="rn-mini" />
                      </div>
                    </div>
                  </article>
                  <article className="rn-card" data-size="sm" style={{ left: 406, top: 16 }}>
                    <header className="rn-card-header">
                      Inspector Card <SlidersHorizontal size={14} />
                    </header>
                    <div className="rn-card-content rn-column">
                      <div className="rn-screen" data-tone="info">Signal stable / index 18.2 / no conflicts</div>
                    </div>
                  </article>
                </div>
              </div>
            </section>
          )}

          {activeTab === "diagnostics" && (
            <section className="rn-main">
              <div className="rn-panel">
                <h2 className="rn-panel-title">AppDialog / Navigation / Popup Patterns</h2>
                <div className="rn-grid">
                  <div className="rn-row">
                    <button className="rn-icon-btn" aria-label="Previous">
                      <ChevronLeft size={16} />
                    </button>
                    <button className="rn-icon-btn" aria-label="Next">
                      <ChevronRight size={16} />
                    </button>
                    <button className="rn-button" onClick={() => setIsDialogOpen(true)}>
                      Open Confirm Dialog
                    </button>
                  </div>
                  <div className="rn-popup">
                    <button type="button">Open card settings</button>
                    <button type="button">Duplicate card</button>
                    <button type="button">Detach panel</button>
                  </div>
                </div>
              </div>

              <div className="rn-panel">
                <h2 className="rn-panel-title">Typography</h2>
                <div className="rn-font-sample">
                  <p>
                    <strong>AppFontSans:</strong> IBM Plex Sans for UI and body text.
                  </p>
                  <p className="rn-mono">
                    <strong>AppFontMono:</strong> Hack (JetBrains Mono fallback) for labels and readouts.
                  </p>
                </div>
              </div>
            </section>
          )}

          {activeTab === "custom" && (
            <section className="rn-main">
              <div className="rn-panel">
                <h2 className="rn-panel-title">ArcGauge Component (Reusable)</h2>
                <div className="rn-grid">
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-lo">Lo</label>
                    <input id="rn-arc-lo" className="rn-field" type="number" value={arcLo} onChange={(e) => setArcLo(Number(e.target.value))} />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-value">Value</label>
                    <input id="rn-arc-value" className="rn-field" type="number" value={arcValue} onChange={(e) => setArcValue(Number(e.target.value))} />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-hi">Hi</label>
                    <input id="rn-arc-hi" className="rn-field" type="number" value={arcHi} onChange={(e) => setArcHi(Number(e.target.value))} />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-empty-warning">EmptyWarning %</label>
                    <input
                      id="rn-arc-empty-warning"
                      className="rn-field"
                      type="number"
                      min={0}
                      max={100}
                      value={arcEmptyWarning}
                      onChange={(e) => setArcEmptyWarning(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-full-warning">FullWarning %</label>
                    <input
                      id="rn-arc-full-warning"
                      className="rn-field"
                      type="number"
                      min={0}
                      max={100}
                      value={arcFullWarning}
                      onChange={(e) => setArcFullWarning(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-scale">Scale ({arcScale}%)</label>
                    <input
                      id="rn-arc-scale"
                      className="rn-slider"
                      type="range"
                      min={60}
                      max={160}
                      step={5}
                      value={arcScale}
                      onChange={(e) => setArcScale(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-major-ticks">Major ticks (total)</label>
                    <input
                      id="rn-arc-major-ticks"
                      className="rn-field"
                      type="number"
                      min={2}
                      max={25}
                      value={arcMajorTicks}
                      onChange={(e) => setArcMajorTicks(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-minor-ticks">Minor ticks (between major)</label>
                    <input
                      id="rn-arc-minor-ticks"
                      className="rn-field"
                      type="number"
                      min={0}
                      max={10}
                      value={arcMinorTicks}
                      onChange={(e) => setArcMinorTicks(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-format-unit">Format unit</label>
                    <select
                      id="rn-arc-format-unit"
                      className="rn-combo"
                      value={arcFormatUnit}
                      onChange={(e) => setArcFormatUnit(e.target.value as "none" | "k" | "m" | "g")}
                    >
                      <option value="none">Raw</option>
                      <option value="k">k</option>
                      <option value="m">m</option>
                      <option value="g">g</option>
                    </select>
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-decimals">Decimal digits</label>
                    <input
                      id="rn-arc-decimals"
                      className="rn-field"
                      type="number"
                      min={0}
                      max={4}
                      value={arcDecimalDigits}
                      onChange={(e) => setArcDecimalDigits(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-label">Gauge label</label>
                    <input id="rn-arc-label" className="rn-field" value={arcLabel} onChange={(e) => setArcLabel(e.target.value)} />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-value-order">Value order</label>
                    <input
                      id="rn-arc-value-order"
                      className="rn-field"
                      type="number"
                      min={1}
                      max={3}
                      value={arcValueOrder}
                      onChange={(e) => setArcValueOrder(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-percent-order">Percentage order</label>
                    <input
                      id="rn-arc-percent-order"
                      className="rn-field"
                      type="number"
                      min={1}
                      max={3}
                      value={arcPercentOrder}
                      onChange={(e) => setArcPercentOrder(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-label-order">Label order</label>
                    <input
                      id="rn-arc-label-order"
                      className="rn-field"
                      type="number"
                      min={1}
                      max={3}
                      value={arcLabelOrder}
                      onChange={(e) => setArcLabelOrder(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-value-scale">Value scale</label>
                    <input
                      id="rn-arc-value-scale"
                      className="rn-field"
                      type="number"
                      min={0.5}
                      max={3}
                      step={0.1}
                      value={arcValueScale}
                      onChange={(e) => setArcValueScale(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-percent-scale">Percentage scale</label>
                    <input
                      id="rn-arc-percent-scale"
                      className="rn-field"
                      type="number"
                      min={0.5}
                      max={3}
                      step={0.1}
                      value={arcPercentScale}
                      onChange={(e) => setArcPercentScale(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="rn-label" htmlFor="rn-arc-label-scale">Label scale</label>
                    <input
                      id="rn-arc-label-scale"
                      className="rn-field"
                      type="number"
                      min={0.5}
                      max={3}
                      step={0.1}
                      value={arcLabelScale}
                      onChange={(e) => setArcLabelScale(Number(e.target.value))}
                    />
                  </div>
                  <label className="rn-control-row">
                    <input className="rn-check" type="checkbox" checked={arcShowValue} onChange={(e) => setArcShowValue(e.target.checked)} />
                    Show value numeral
                  </label>
                  <label className="rn-control-row">
                    <input className="rn-check" type="checkbox" checked={arcShowPercent} onChange={(e) => setArcShowPercent(e.target.checked)} />
                    Show percentage
                  </label>
                  <label className="rn-control-row">
                    <input className="rn-check" type="checkbox" checked={arcShowHiLo} onChange={(e) => setArcShowHiLo(e.target.checked)} />
                    Show Hi/Lo labels
                  </label>
                  <label className="rn-control-row">
                    <input
                      className="rn-check"
                      type="checkbox"
                      checked={arcShowGaugeLabel}
                      onChange={(e) => setArcShowGaugeLabel(e.target.checked)}
                    />
                    Show gauge label
                  </label>
                </div>
              </div>

              <ArcGaugeCard
                title="ArcGauge Card"
                description="Reusable wrapper with header + gauge content"
                lo={arcLo}
                value={arcValue}
                hi={arcHi}
                emptyWarning={arcEmptyWarning}
                fullWarning={arcFullWarning}
                scalePercent={arcScale}
                majorTicksTotal={arcMajorTicks}
                minorTicksBetweenMajor={arcMinorTicks}
                formatUnit={arcFormatUnit}
                decimalDigits={arcDecimalDigits}
                label={arcLabel}
                showValueNumeral={arcShowValue}
                showPercentage={arcShowPercent}
                showHiLo={arcShowHiLo}
                showGaugeLabel={arcShowGaugeLabel}
                valueOrder={arcValueOrder}
                percentageOrder={arcPercentOrder}
                labelOrder={arcLabelOrder}
                valueScale={arcValueScale}
                percentageScale={arcPercentScale}
                labelScale={arcLabelScale}
                valueAccent={1}
                emptyWarningAccent={6}
                fullWarningAccent={4}
                cardClassName="p-2"
                gaugeClassName=""
              />
            </section>
          )}
        </section>
      </div>

      {isDialogOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[rgba(18,31,38,0.55)] backdrop-blur-[1px]">
          <div className="w-[min(92vw,560px)] overflow-hidden rounded-[5px] border border-[#8e8878] bg-[#e9e5d7] shadow-none">
            <header className="rn-titlebar">
              <strong className="rn-titlebar-label">AppDialog / Confirm Broadcast</strong>
            </header>
            <div className="grid gap-2 p-2.5">
              <p>Push current deck layout and control state to all connected stations?</p>
              <div className="rn-row">
                <button
                  className="rn-button"
                  onClick={() => {
                    setIsDialogOpen(false);
                    setToast("Broadcast dispatched");
                  }}
                >
                  Confirm
                </button>
                <button className="rn-button" data-variant="secondary" onClick={() => setIsDialogOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div
        className={`pointer-events-none fixed bottom-3 right-3 rounded-[3px] border border-[#8e8878] bg-[#d7d2c3] px-2 py-1 font-mono text-[0.68rem] uppercase tracking-[0.05em] text-[#29343c] shadow-none transition-all ${
          toast ? "translate-y-0 opacity-100" : "translate-y-[10px] opacity-0"
        }`}
      >
        {toast ?? " "}
      </div>
    </div>
  );
}
