/**
 * gallery-tug-cue.tsx — `Cue` Phase 2 production gallery card.
 *
 * Phase 1 (now committed) shipped 7 prototype variants A–G inline so the
 * user could vet visually. Variant G — *roman text · ChevronsUpDown leading
 * icon · subtle accent bg · hairline borders top/bottom* — was selected. This
 * file is now Phase 2: it imports the finished `<Cue>` and exercises every
 * prop / state combination the API supports.
 *
 * Sections:
 *  - Real-host preview — `<Cue>` mounted inside a fake-FileBlock frame,
 *    showing the cue as it'll appear at the live FileBlock / DiffBlock call
 *    sites. A small control row drives `role`, `density`, `disabled`,
 *    `aria-expanded`, and whether the leading icon is present.
 *  - Role matrix — every role (active, accent, agent, caution, danger,
 *    data, success) at compact density with leading icon.
 *  - Disabled showcase — confirms clicks are blocked when `disabled`.
 *
 * @module components/tugways/cards/gallery-tug-cue
 */

import React, { useId, useState } from "react";
import { ChevronsUpDown, ChevronsDown, ChevronsUp, Copy } from "lucide-react";

import { TugDisclosure } from "@/components/tugways/tug-disclosure";
import { Cue } from "@/components/tugways/body-kinds/cue";
import type { CueDensity, CueRole } from "@/components/tugways/body-kinds/cue";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TugBox } from "@/components/tugways/tug-box";
import { TugCheckbox } from "@/components/tugways/tug-checkbox";
import { TugPopupButton } from "@/components/tugways/tug-popup-button";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { TUG_ACTIONS } from "../action-vocabulary";
import "./gallery-tug-cue.css";

const ALL_ROLES: readonly CueRole[] = [
  "active",
  "accent",
  "agent",
  "caution",
  "danger",
  "data",
  "success",
  "muted",
];
const ALL_DENSITIES: readonly CueDensity[] = ["compact", "regular"];

interface DebugEntry {
  source: string;
  at: number;
}

function formatTime(t: number): string {
  const d = new Date(t);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}.${d.getMilliseconds().toString().padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// HostPreview
// ---------------------------------------------------------------------------

/** Mounts <Cue> inside a fake-FileBlock frame. */
function HostPreview({
  role,
  density,
  disabled,
  expanded,
  withIcon,
  onActivate,
}: {
  role: CueRole;
  density: CueDensity;
  disabled: boolean;
  expanded: boolean;
  withIcon: boolean;
  onActivate: () => void;
}) {
  const label = expanded
    ? "click to collapse"
    : "1,230 lines folded — click to expand";
  return (
    <div className="cg-tug-cue-host">
      <div className="cg-tug-cue-host-header">
        <span>src/components/tugways/internal/session-card-transcript.tsx</span>
      </div>
      <pre className="cg-tug-cue-host-body-pre">{`  1  export function SessionCardTranscript({ cardId, turn }: Props) {
  2    const turns = useTurns(cardId);
  3    return (
  4      <div className="session-card-transcript">
  5        {turns.map((t) => (
  6          <TranscriptTurn key={t.id} turn={t} />
  7        ))}
  8      </div>
  9    );`}</pre>
      {expanded ? (
        <pre className="cg-tug-cue-host-body-pre">{` 10  }
 11
 12  // (… 1,230 more lines …)`}</pre>
      ) : null}
      <Cue
        role={role}
        density={density}
        disabled={disabled}
        aria-expanded={expanded}
        icon={withIcon ? <ChevronsUpDown /> : undefined}
        onClick={onActivate}
      >
        {label}
      </Cue>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GalleryTugCue
// ---------------------------------------------------------------------------

export function GalleryTugCue() {
  const [debug, setDebug] = useState<readonly DebugEntry[]>([]);
  const [hostExpanded, setHostExpanded] = useState(false);
  const [hostRole, setHostRole] = useState<CueRole>("active");
  const [hostDensity, setHostDensity] = useState<CueDensity>("compact");
  const [hostDisabled, setHostDisabled] = useState(false);
  const [hostWithIcon, setHostWithIcon] = useState(true);

  const [matrixExpandedById, setMatrixExpandedById] = useState<Record<string, boolean>>({});

  const record = (source: string) => {
    setDebug((prev) => [{ source, at: Date.now() }, ...prev].slice(0, 8));
  };

  const onHostActivate = () => {
    record("host-preview");
    setHostExpanded((v) => !v);
  };

  const onMatrixActivate = (id: string) => () => {
    record(`matrix:${id}`);
    setMatrixExpandedById((m) => ({ ...m, [id]: !m[id] }));
  };

  // Responder-form for the host preview controls. Checkbox toggles bind to
  // the toggle slot; the two pickers (role, density) bind to setValueString.
  const expandedId = useId();
  const disabledId = useId();
  const withIconId = useId();
  const roleId = useId();
  const densityId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    toggle: {
      [expandedId]: setHostExpanded,
      [disabledId]: setHostDisabled,
      [withIconId]: setHostWithIcon,
    },
    setValueString: {
      [roleId]: (v) => setHostRole(v as CueRole),
      [densityId]: (v) => setHostDensity(v as CueDensity),
    },
  });

  return (
    <ResponderScope>
      <div
        className="cg-content"
        data-testid="gallery-tug-cue"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        {/* ---- Real-Host Preview ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Real-host preview</TugLabel>
          <TugBox variant="bordered" rounded="sm" style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
            <div className="cg-control-group">
              <TugLabel size="2xs" emphasis="calm">Role</TugLabel>
              <TugPopupButton
                label={hostRole}
                size="sm"
                senderId={roleId}
                items={ALL_ROLES.map((r) => ({
                  action: TUG_ACTIONS.SET_VALUE,
                  value: r,
                  label: r,
                }))}
              />
            </div>
            <div className="cg-control-group">
              <TugLabel size="2xs" emphasis="calm">Density</TugLabel>
              <TugPopupButton
                label={hostDensity}
                size="sm"
                senderId={densityId}
                items={ALL_DENSITIES.map((d) => ({
                  action: TUG_ACTIONS.SET_VALUE,
                  value: d,
                  label: d,
                }))}
              />
            </div>
            <div className="cg-control-group">
              <TugCheckbox checked={hostExpanded} senderId={expandedId} label="Expanded" size="sm" />
            </div>
            <div className="cg-control-group">
              <TugCheckbox checked={hostDisabled} senderId={disabledId} label="Disabled" size="sm" />
            </div>
            <div className="cg-control-group">
              <TugCheckbox checked={hostWithIcon} senderId={withIconId} label="Leading icon" size="sm" />
            </div>
          </TugBox>
          <div style={{ marginTop: "12px" }}>
            <HostPreview
              role={hostRole}
              density={hostDensity}
              disabled={hostDisabled}
              expanded={hostExpanded}
              withIcon={hostWithIcon}
              onActivate={onHostActivate}
            />
          </div>
        </div>

        <TugSeparator />

        {/* ---- Role matrix ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Role matrix — all 7 roles at compact density</TugLabel>
          <div className="cg-tug-cue-stack">
            {ALL_ROLES.map((role) => {
              const id = `role-${role}`;
              const expanded = !!matrixExpandedById[id];
              return (
                <div key={id} className="cg-tug-cue-row">
                  <div className="cg-tug-cue-row-label">role={role}</div>
                  <div>
                    <div className="cg-tug-cue-frame">
                      <Cue
                        role={role}
                        density="compact"
                        aria-expanded={expanded}
                        icon={<ChevronsUpDown />}
                        onClick={onMatrixActivate(id)}
                      >
                        {expanded
                          ? "click to collapse"
                          : `${role} cue — click to expand`}
                      </Cue>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <TugSeparator />

        {/* ---- Density matrix ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Density matrix — active role × 2 densities × icon on/off</TugLabel>
          <div className="cg-tug-cue-stack">
            {ALL_DENSITIES.flatMap((density) =>
              [true, false].map((withIcon) => {
                const id = `density-${density}-${withIcon ? "icon" : "no-icon"}`;
                const expanded = !!matrixExpandedById[id];
                return (
                  <div key={id} className="cg-tug-cue-row">
                    <div className="cg-tug-cue-row-label">
                      {density} · {withIcon ? "icon" : "no icon"}
                    </div>
                    <div>
                      <div className="cg-tug-cue-frame">
                        <Cue
                          role="active"
                          density={density}
                          aria-expanded={expanded}
                          icon={withIcon ? <ChevronsUpDown /> : undefined}
                          onClick={onMatrixActivate(id)}
                        >
                          {expanded
                            ? "click to collapse"
                            : "1,230 lines folded — click to expand"}
                        </Cue>
                      </div>
                    </div>
                  </div>
                );
              }),
            )}
          </div>
        </div>

        <TugSeparator />

        {/* ---- Affordance use-cases ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Affordance use-cases — three shapes for collapse / expand</TugLabel>
          <TugLabel size="xs" emphasis="calm">
            Shape A — reveal cue (Cue role=active). Shape B — structural divider (Cue role=muted align=start mono). Shape C — header collapse toggle (TugIconButton with ChevronsUp). All three pictured inside fake-FileBlock frames so the call-site context reads true.
          </TugLabel>

          {/* Shape A — collapsed FileBlock with reveal cue */}
          {(() => {
            const id = "use-case-shape-a";
            const expanded = !!matrixExpandedById[id];
            return (
              <div style={{ marginTop: "12px" }}>
                <TugLabel size="2xs" emphasis="calm">Shape A — reveal cue (collapsed FileBlock)</TugLabel>
                <div className="cg-tug-cue-host">
                  <div className="cg-tug-cue-host-header">
                    <span>src/components/tugways/big-file.tsx</span>
                  </div>
                  {expanded ? (
                    <pre className="cg-tug-cue-host-body-pre">{`  1  export function BigFile() {
  2    return <div>… 1,230 lines …</div>;
  3  }`}</pre>
                  ) : null}
                  <Cue
                    role="active"
                    icon={<ChevronsDown />}
                    aria-expanded={expanded}
                    onClick={onMatrixActivate(id)}
                  >
                    {expanded ? "click to collapse" : "1,230 lines folded — click to expand"}
                  </Cue>
                </div>
              </div>
            );
          })()}

          {/* Shape B — code-context (diff hunk header) */}
          {(() => {
            const id = "use-case-shape-b";
            const expanded = !!matrixExpandedById[id];
            return (
              <div style={{ marginTop: "12px" }}>
                <TugLabel size="2xs" emphasis="calm">Shape B — structural divider (diff hunk header)</TugLabel>
                <div className="cg-tug-cue-frame">
                  <Cue
                    role="muted"
                    align="start"
                    mono
                    icon={<TugDisclosure expanded={expanded} />}
                    aria-expanded={expanded}
                    onClick={onMatrixActivate(id)}
                  >
                    @@ -217,21 +217,21 @@ Higher-level components assembled from multiple primitives.
                  </Cue>
                </div>
              </div>
            );
          })()}

          {/* Shape C — expanded FileBlock with header toggle */}
          {(() => {
            const id = "use-case-shape-c";
            const collapsed = !!matrixExpandedById[id]; // toggled
            return (
              <div style={{ marginTop: "12px" }}>
                <TugLabel size="2xs" emphasis="calm">Shape C — header collapse toggle (TugIconButton, paired with Copy)</TugLabel>
                <div className="cg-tug-cue-host">
                  <div className="cg-tug-cue-host-header">
                    <span style={{ flex: 1 }}>src/components/tugways/big-file.tsx</span>
                    <TugIconButton size="sm"
                      icon={<Copy />}
                      aria-label="Copy file"
                      onClick={() => onMatrixActivate(`${id}-copy`)()}
                    />
                    <TugIconButton size="sm"
                      icon={collapsed ? <ChevronsDown /> : <ChevronsUp />}
                      aria-label={collapsed ? "Expand file" : "Collapse file"}
                      onClick={onMatrixActivate(id)}
                    />
                  </div>
                  {collapsed ? null : (
                    <pre className="cg-tug-cue-host-body-pre">{`  1  export function BigFile() {
  2    return <div>… visible content …</div>;
  3  }`}</pre>
                  )}
                </div>
              </div>
            );
          })()}
        </div>

        <TugSeparator />

        {/* ---- Disabled showcase ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Disabled state</TugLabel>
          <div className="cg-tug-cue-frame">
            <Cue
              role="active"
              density="compact"
              disabled
              icon={<ChevronsUpDown />}
              onClick={() => record("should-not-fire")}
            >
              disabled cue — clicks do not fire onClick
            </Cue>
          </div>
        </div>

        <TugSeparator />

        {/* ---- Activation log ---- */}
        <div className="cg-section">
          <TugLabel className="cg-section-title">Activation log (latest 8)</TugLabel>
          <div className="cg-tug-cue-debug">
            {debug.length === 0 ? (
              <span className="cg-tug-cue-debug-empty">
                no activations yet — click any cue, or focus and press Enter / Space
              </span>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                {debug.map((e, i) => (
                  <span key={i}>
                    {formatTime(e.at)} · {e.source}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </ResponderScope>
  );
}
