/**
 * gallery-accordion.tsx -- TugAccordion demo tab for the Component Gallery.
 *
 * Shows TugAccordion in all modes: single, multiple, default open, variants
 * (separator, outline, inset, plain), disabled (root and item-level), TugBox
 * disabled cascade, rich triggers with icons, and nested tugways components.
 *
 * @module components/tugways/cards/gallery-accordion
 */

import React, { useId, useState } from "react";
import { Settings, User, Bell } from "lucide-react";
import { TugAccordion, TugAccordionItem } from "@/components/tugways/tug-accordion";
import { TugBox } from "@/components/tugways/tug-box";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugInput } from "@/components/tugways/tug-input";
import { TugSwitch } from "@/components/tugways/tug-switch";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { useFocusable } from "@/components/tugways/use-focusable";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

// Shared text style for paragraph content inside accordion items
const paraStyle: React.CSSProperties = {
  fontSize: "0.875rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  margin: 0,
  lineHeight: "1.5",
};

const labelStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  marginBottom: "4px",
};

/**
 * A navigable inner control for the Focus Language section content — proves the
 * accordion's Enter-descend ([P02]): once the user descends into the open
 * section, this button becomes the key view and Space/Enter act on it. It
 * registers into the section's pushed focus mode (supplied by TugAccordionItem
 * via FocusModeContext), so it is unreachable until the user descends.
 */
function AccordionInnerAction() {
  const id = useId();
  const [count, setCount] = useState(0);
  const { focusableRef } = useFocusable({
    id,
    group: "gallery-accordion-inner",
    order: 0,
    register: true,
  });
  return (
    <button
      ref={(el) => focusableRef(el)}
      type="button"
      data-testid="accordion-inner-button"
      data-count={count}
      onClick={() => setCount((c) => c + 1)}
    >
      Inner action (count: {count})
    </button>
  );
}

// ---------------------------------------------------------------------------
// GalleryAccordion
// ---------------------------------------------------------------------------

export function GalleryAccordion() {
  // L11 migration (A2.4): two controlled accordions driven through the
  // responder chain via useResponderForm. The single-mode binding lives in
  // `toggleSectionSingle` (string payload); the multi-mode binding in
  // `toggleSectionMulti` (string[] payload). Gensym'd sender ids per
  // accordion. See gallery-checkbox.tsx for the annotated reference.
  const [chainSingle, setChainSingle] = useState<string>("docs");
  const [chainMulti, setChainMulti] = useState<string[]>(["alerts", "privacy"]);

  // Focus Language section — a collapsible single-mode accordion authored into a
  // focus group so the engine drives Tab. Starts fully collapsed so the test
  // can prove Space expands the focused header.
  const [focusOpen, setFocusOpen] = useState<string>("");

  const chainSingleId = useId();
  const chainMultiId = useId();
  const focusAccordionId = useId();

  const { ResponderScope, responderRef } = useResponderForm({
    toggleSectionSingle: {
      [chainSingleId]: setChainSingle,
      [focusAccordionId]: setFocusOpen,
    },
    toggleSectionMulti: { [chainMultiId]: setChainMulti },
  });

  return (
    <ResponderScope>
    <div
      className="cg-content"
      data-testid="gallery-accordion"
      ref={responderRef as (el: HTMLDivElement | null) => void}
    >

      {/* ---- Focus Language ---- */}
      {/* First section so the headers sit above the fold for native clicks. The
          accordion is authored into a focus group, so the engine drives Tab in
          this card: Tab lands the key view on the cursor header (ring on
          keyboard focus), Up/Down rove between headers locally, and Space/Enter
          expand/collapse the focused header. */}
      <div className="cg-section" data-testid="accordion-focus-demo">
        <TugLabel className="cg-section-title" data-testid="accordion-focus-title">Focus Language</TugLabel>
        <div style={{ maxWidth: "480px" }}>
          <TugAccordion
            type="single"
            collapsible
            value={focusOpen}
            senderId={focusAccordionId}
            focusGroup="gallery-accordion-focus"
            focusOrder={0}
          >
            <TugAccordionItem value="first" trigger="First section">
              <p style={paraStyle}>First section body.</p>
              <AccordionInnerAction />
            </TugAccordionItem>
            <TugAccordionItem value="second" trigger="Second section">
              <p style={paraStyle}>Second section body.</p>
            </TugAccordionItem>
            <TugAccordionItem value="third" trigger="Third section">
              <p style={paraStyle}>Third section body.</p>
            </TugAccordionItem>
          </TugAccordion>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 1. Single Mode ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Single Mode</TugLabel>
        <div style={{ maxWidth: "480px" }}>
          <TugAccordion
            type="single"
            collapsible
            componentStatePreservationKey="single"
            data-testid="gallery-accordion-single"
          >
            <TugAccordionItem value="getting-started" trigger="Getting Started">
              <p style={paraStyle}>
                Welcome to the platform. This section walks you through the key concepts
                and helps you get up and running quickly.
              </p>
            </TugAccordionItem>
            <TugAccordionItem value="installation" trigger="Installation">
              <p style={paraStyle}>
                Install the package using your preferred package manager. Run
                <code> bun install my-package</code> or <code>npm install my-package</code> to
                add it to your project.
              </p>
            </TugAccordionItem>
            <TugAccordionItem value="configuration" trigger="Configuration">
              <p style={paraStyle}>
                Create a <code>config.json</code> file in your project root. Set the
                required fields and override any defaults that don't fit your environment.
              </p>
            </TugAccordionItem>
          </TugAccordion>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 2. Multiple Mode ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Multiple Mode</TugLabel>
        <div style={{ maxWidth: "480px" }}>
          <TugAccordion type="multiple" componentStatePreservationKey="multiple" data-testid="gallery-accordion-multiple">
            <TugAccordionItem value="features" trigger="Features">
              <p style={paraStyle}>
                Explore the full feature set: real-time collaboration, version history,
                plugin extensions, and custom theming support.
              </p>
            </TugAccordionItem>
            <TugAccordionItem value="api-reference" trigger="API Reference">
              <p style={paraStyle}>
                The REST API exposes endpoints for all core resources. Authentication
                uses Bearer tokens. Full OpenAPI spec available at <code>/docs/api</code>.
              </p>
            </TugAccordionItem>
            <TugAccordionItem value="examples" trigger="Examples">
              <p style={paraStyle}>
                Sample projects and runnable code snippets are available in the
                <code> /examples</code> directory. Each example is self-contained and
                documented inline.
              </p>
            </TugAccordionItem>
          </TugAccordion>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 3. Default Open ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Default Open</TugLabel>
        <div style={{ maxWidth: "480px" }}>
          <div style={labelStyle}>defaultValue="second-item" — second panel opens on mount</div>
          <TugAccordion type="single" collapsible defaultValue="second-item">
            <TugAccordionItem value="first-item" trigger="First Item">
              <p style={paraStyle}>Content of the first item. Click to collapse.</p>
            </TugAccordionItem>
            <TugAccordionItem value="second-item" trigger="Second Item">
              <p style={paraStyle}>
                This item is open by default via <code>defaultValue="second-item"</code>.
                The accordion is uncontrolled — state is managed internally by Radix.
              </p>
            </TugAccordionItem>
            <TugAccordionItem value="third-item" trigger="Third Item">
              <p style={paraStyle}>Content of the third item. Click to expand.</p>
            </TugAccordionItem>
          </TugAccordion>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 4. Variants ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Variants</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "480px" }}>
          <div>
            <div style={labelStyle}>variant="separator" (default) — divider lines between items</div>
            <TugAccordion type="single" collapsible>
              <TugAccordionItem value="item-a" trigger="Alpha">
                <p style={paraStyle}>Content for Alpha.</p>
              </TugAccordionItem>
              <TugAccordionItem value="item-b" trigger="Beta">
                <p style={paraStyle}>Content for Beta.</p>
              </TugAccordionItem>
              <TugAccordionItem value="item-c" trigger="Gamma">
                <p style={paraStyle}>Content for Gamma.</p>
              </TugAccordionItem>
            </TugAccordion>
          </div>
          <div>
            <div style={labelStyle}>variant="outline" — single border around the group</div>
            <TugAccordion type="single" collapsible variant="outline">
              <TugAccordionItem value="item-a" trigger="Alpha">
                <p style={paraStyle}>Content for Alpha.</p>
              </TugAccordionItem>
              <TugAccordionItem value="item-b" trigger="Beta">
                <p style={paraStyle}>Content for Beta.</p>
              </TugAccordionItem>
              <TugAccordionItem value="item-c" trigger="Gamma">
                <p style={paraStyle}>Content for Gamma.</p>
              </TugAccordionItem>
            </TugAccordion>
          </div>
          <div>
            <div style={labelStyle}>variant="inset" — each item bordered with gap between</div>
            <TugAccordion type="single" collapsible variant="inset">
              <TugAccordionItem value="item-a" trigger="Alpha">
                <p style={paraStyle}>Content for Alpha.</p>
              </TugAccordionItem>
              <TugAccordionItem value="item-b" trigger="Beta">
                <p style={paraStyle}>Content for Beta.</p>
              </TugAccordionItem>
              <TugAccordionItem value="item-c" trigger="Gamma">
                <p style={paraStyle}>Content for Gamma.</p>
              </TugAccordionItem>
            </TugAccordion>
          </div>
          <div>
            <div style={labelStyle}>variant="plain" — no borders</div>
            <TugAccordion type="single" collapsible variant="plain">
              <TugAccordionItem value="item-a" trigger="Alpha">
                <p style={paraStyle}>Content for Alpha.</p>
              </TugAccordionItem>
              <TugAccordionItem value="item-b" trigger="Beta">
                <p style={paraStyle}>Content for Beta.</p>
              </TugAccordionItem>
              <TugAccordionItem value="item-c" trigger="Gamma">
                <p style={paraStyle}>Content for Gamma.</p>
              </TugAccordionItem>
            </TugAccordion>
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 5. Disabled ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Disabled</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "480px" }}>
          <div>
            <div style={labelStyle}>disabled on root — all items non-interactive</div>
            <TugAccordion type="single" collapsible disabled>
              <TugAccordionItem value="dis-a" trigger="Section A">
                <p style={paraStyle}>Content A.</p>
              </TugAccordionItem>
              <TugAccordionItem value="dis-b" trigger="Section B">
                <p style={paraStyle}>Content B.</p>
              </TugAccordionItem>
            </TugAccordion>
          </div>
          <div>
            <div style={labelStyle}>disabled on a single item — only "Middle" is non-interactive</div>
            <TugAccordion type="single" collapsible>
              <TugAccordionItem value="mix-a" trigger="First (enabled)">
                <p style={paraStyle}>This item is interactive.</p>
              </TugAccordionItem>
              <TugAccordionItem value="mix-b" trigger="Middle (disabled)" disabled>
                <p style={paraStyle}>This item is disabled individually.</p>
              </TugAccordionItem>
              <TugAccordionItem value="mix-c" trigger="Last (enabled)">
                <p style={paraStyle}>This item is interactive.</p>
              </TugAccordionItem>
            </TugAccordion>
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 6. TugBox Cascade ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugBox Cascade</TugLabel>
        <div style={{ maxWidth: "480px" }}>
          <TugBox variant="bordered" label="Disabled via TugBox" disabled={true}>
            <TugAccordion type="single" collapsible>
              <TugAccordionItem value="box-a" trigger="Notifications">
                <p style={paraStyle}>Notification preferences and alert settings.</p>
              </TugAccordionItem>
              <TugAccordionItem value="box-b" trigger="Privacy">
                <p style={paraStyle}>Data sharing and visibility controls.</p>
              </TugAccordionItem>
              <TugAccordionItem value="box-c" trigger="Security">
                <p style={paraStyle}>Password, two-factor authentication, and active sessions.</p>
              </TugAccordionItem>
            </TugAccordion>
          </TugBox>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 7. Rich Triggers ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Rich Triggers</TugLabel>
        <div style={{ maxWidth: "480px" }}>
          <div style={labelStyle}>trigger accepts any ReactNode — icon + text layout via flex</div>
          <TugAccordion type="single" collapsible>
            <TugAccordionItem
              value="rich-settings"
              trigger={
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <Settings size={16} aria-hidden="true" />
                  <span>Settings</span>
                </div>
              }
            >
              <p style={paraStyle}>
                Manage application preferences, keyboard shortcuts, and display options.
              </p>
            </TugAccordionItem>
            <TugAccordionItem
              value="rich-profile"
              trigger={
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <User size={16} aria-hidden="true" />
                  <span>Profile</span>
                </div>
              }
            >
              <p style={paraStyle}>
                Update your display name, avatar, and account-level preferences.
              </p>
            </TugAccordionItem>
            <TugAccordionItem
              value="rich-notifications"
              trigger={
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <Bell size={16} aria-hidden="true" />
                  <span>Notifications</span>
                </div>
              }
            >
              <p style={paraStyle}>
                Choose which events trigger alerts and configure delivery channels.
              </p>
            </TugAccordionItem>
          </TugAccordion>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 8. Nested Content ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Nested Content</TugLabel>
        <div style={{ maxWidth: "480px" }}>
          <div style={labelStyle}>accordion as a container for real UI — TugBadge, TugProgressIndicator, TugInput, TugSwitch</div>
          <TugAccordion type="multiple">
            <TugAccordionItem value="nested-status" trigger="Status Badges">
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                <TugBadge size="sm" role="success" emphasis="tinted">Deployed</TugBadge>
                <TugBadge size="sm" role="caution" emphasis="tinted">Pending Review</TugBadge>
                <TugBadge size="sm" role="danger" emphasis="tinted">Build Failed</TugBadge>
                <TugBadge size="sm" role="accent" emphasis="ghost">Draft</TugBadge>
              </div>
            </TugAccordionItem>
            <TugAccordionItem value="nested-progress" trigger="Upload Progress">
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <TugProgressIndicator variant="bar" size={6} value={0.6} label="assets.zip — 60%" />
                <TugProgressIndicator variant="bar" size={6} value={1} label="config.json — complete" tone="success" />
              </div>
            </TugAccordionItem>
            <TugAccordionItem value="nested-input" trigger="Quick Search">
              <TugInput placeholder="Search documentation..." style={{ width: "100%" }} />
            </TugAccordionItem>
            <TugAccordionItem value="nested-toggles" trigger="Feature Flags">
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={paraStyle}>Dark mode</span>
                  <TugSwitch defaultChecked aria-label="Dark mode" />
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={paraStyle}>Beta features</span>
                  <TugSwitch aria-label="Beta features" />
                </div>
              </div>
            </TugAccordionItem>
          </TugAccordion>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 9. Chain-controlled (A2.4) ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Chain-Controlled (A2.4)</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "480px" }}>
          <div>
            <div style={labelStyle}>
              single mode — dispatches <code>toggleSection</code> with <code>string</code>,
              handled via <code>useResponderForm.toggleSectionSingle</code>
            </div>
            <TugAccordion
              type="single"
              collapsible
              value={chainSingle}
              senderId={chainSingleId}
            >
              <TugAccordionItem value="docs" trigger="Documentation">
                <p style={paraStyle}>Reference guides and API docs.</p>
              </TugAccordionItem>
              <TugAccordionItem value="examples" trigger="Examples">
                <p style={paraStyle}>Sample projects and runnable snippets.</p>
              </TugAccordionItem>
              <TugAccordionItem value="support" trigger="Support">
                <p style={paraStyle}>Community forums and bug reports.</p>
              </TugAccordionItem>
            </TugAccordion>
            <div style={{ fontSize: "0.75rem", color: "var(--tug7-element-field-text-normal-label-rest)", marginTop: "8px" }}>
              Open: <strong>{chainSingle === "" ? "none" : chainSingle}</strong>
            </div>
          </div>
          <div>
            <div style={labelStyle}>
              multi mode — dispatches <code>toggleSection</code> with <code>string[]</code>,
              handled via <code>useResponderForm.toggleSectionMulti</code>
            </div>
            <TugAccordion
              type="multiple"
              value={chainMulti}
              senderId={chainMultiId}
            >
              <TugAccordionItem value="alerts" trigger="Alerts">
                <p style={paraStyle}>Notification channels and thresholds.</p>
              </TugAccordionItem>
              <TugAccordionItem value="privacy" trigger="Privacy">
                <p style={paraStyle}>Data sharing and tracking preferences.</p>
              </TugAccordionItem>
              <TugAccordionItem value="security" trigger="Security">
                <p style={paraStyle}>Password, 2FA, and active sessions.</p>
              </TugAccordionItem>
            </TugAccordion>
            <div style={{ fontSize: "0.75rem", color: "var(--tug7-element-field-text-normal-label-rest)", marginTop: "8px" }}>
              Open: <strong>{chainMulti.length === 0 ? "none" : chainMulti.join(", ")}</strong>
            </div>
          </div>
        </div>
      </div>

    </div>
    </ResponderScope>
  );
}
