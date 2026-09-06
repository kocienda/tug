/**
 * settings-general-body.tsx — the General settings panel.
 *
 * App-wide preferences that belong to the app itself rather than to a card
 * type. Two rows today, both directories. The **default project directory** —
 * where Tug looks when nothing else says otherwise (Open Quickly with no
 * bound card, and the session picker's path seed when there are no recents).
 * And the **briefs directory** — where a brief is written when the user asks
 * for one. That second value is a *template* rather than a path: it may carry
 * `{project_dir}`, and `tugtool brief dir` is what resolves it per project.
 *
 * Both stored values are optional: unset reads through to `<home>/tug` and to
 * `{project_dir}/briefs` respectively, each shown in its field as a
 * placeholder so the user sees what they will get without the fallback being
 * written back as if they had chosen it.
 *
 * **The field never comes to rest on a value tugbank doesn't hold.** A path
 * shown in a settled field is a claim about what Tug will do — Open Quickly
 * names that directory in its search bar — so an edit that merely *looks*
 * finished is a lie the user has no way to see. Local state exists only while
 * the user is actively typing; the moment the field settles (a completion
 * accepted, Enter, focus leaving, the native picker returning) the value is
 * written and the field goes back to displaying the store. A write that is
 * refused takes the field back with it rather than leaving the typing on
 * screen looking saved.
 *
 * Laws: the stored path is external state read through `useTugbankValue`
 * ([L02] via `useSyncExternalStore`); only the in-flight edit is component
 * `useState`; the stored path is canonicalized server-side before it is
 * written ([L29] — it is a persisted key, matched against project bindings and
 * recents — while the briefs template is stored verbatim, since nothing
 * compares it and a template names no directory that exists); layout lives in
 * settings-general-body.css [L06].
 *
 * @module components/tugways/cards/settings-general-body
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { TugBox } from "../tug-box";
import { TugLabel } from "../tug-label";
import { TugFileChooser } from "../tug-file-chooser";
import { useResponderForm } from "../use-responder-form";
import { useHostFacts } from "@/lib/host-facts-store";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import { probeDirExistence } from "@/lib/dir-existence";
import {
  DEFAULT_PROJECT_PATH_DOMAIN,
  DEFAULT_PROJECT_PATH_KEY,
  DEFAULT_PROJECT_DIR_LEAF,
  putDefaultProjectPath,
  BRIEFS_PATH_DOMAIN,
  BRIEFS_PATH_KEY,
  DEFAULT_BRIEFS_TEMPLATE,
  putBriefsPath,
} from "@/settings-api";
import type { TaggedValue } from "@/lib/tugbank-client";
import "./settings-general-body.css";

/** Read the explicit stored path out of a tugbank entry. */
function parseStoredPath(entry: TaggedValue | undefined): string {
  if (entry && entry.kind === "string" && typeof entry.value === "string") {
    return entry.value;
  }
  return "";
}

export function SettingsGeneralBody() {
  const hostFacts = useHostFacts();
  const home = hostFacts?.home ?? null;
  const resolvedFallback =
    home === null
      ? ""
      : `${home.replace(/\/+$/, "")}/${DEFAULT_PROJECT_DIR_LEAF}`;

  const stored = useTugbankValue(
    DEFAULT_PROJECT_PATH_DOMAIN,
    DEFAULT_PROJECT_PATH_KEY,
    parseStoredPath,
    "",
  );

  // The in-flight edit, or null when the field is showing the stored value.
  // Typing forks a draft; settling writes it and drops back to reading the
  // store, so a draft can only ever exist under the user's hands.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? stored;

  // Whether the currently shown path exists on disk. `null` while unknown —
  // the note only appears once the probe answers "no".
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const probe = value !== "" ? value : resolvedFallback;
    if (probe === "") {
      setMissing(false);
      return;
    }
    let cancelled = false;
    void probeDirExistence([probe]).then((result) => {
      if (!cancelled) setMissing(result[probe] === false);
    });
    return () => {
      cancelled = true;
    };
  }, [value, resolvedFallback]);

  // Guards a settle against a later one: two settles can be in flight (accept
  // then blur), and the older write must not clear a draft the user has since
  // started, nor land after the newer value.
  const settleSeq = useRef(0);

  // The field settled on `next` — write it, then drop the draft so the field
  // reads the store again. Whatever the store ends up holding is what shows:
  // a canonicalized spelling, or the previous value if the write was refused.
  const settle = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      const seq = (settleSeq.current += 1);
      if (trimmed === stored) {
        setDraft(null);
        return;
      }
      void putDefaultProjectPath(trimmed).then(() => {
        if (seq === settleSeq.current) setDraft(null);
      });
    },
    [stored],
  );

  // The briefs directory, the same shape one row down: stored template, an
  // in-flight draft, a settle guarded against a later one. No existence probe
  // — a template is not a directory, so "does it exist" has no answer.
  const briefsStored = useTugbankValue(
    BRIEFS_PATH_DOMAIN,
    BRIEFS_PATH_KEY,
    parseStoredPath,
    "",
  );
  const [briefsDraft, setBriefsDraft] = useState<string | null>(null);
  const briefsValue = briefsDraft ?? briefsStored;
  const briefsSettleSeq = useRef(0);
  const settleBriefs = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      const seq = (briefsSettleSeq.current += 1);
      if (trimmed === briefsStored) {
        setBriefsDraft(null);
        return;
      }
      void putBriefsPath(trimmed).then(() => {
        if (seq === briefsSettleSeq.current) setBriefsDraft(null);
      });
    },
    [briefsStored],
  );

  const { ResponderScope, responderRef } = useResponderForm({});

  return (
    <ResponderScope>
      <div
        className="settings-general"
        data-testid="settings-general"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <TugBox
          label="Default Project Directory"
          labelPosition="legend"
          variant="bordered"
          className="settings-general-group"
        >
          <div
            className="settings-general-field"
            data-testid="settings-default-project-dir-field"
          >
            <TugFileChooser
              value={value}
              onChange={setDraft}
              base={value !== "" ? value : home ?? "/"}
              kind="directory"
              onSettle={settle}
              placeholder={resolvedFallback}
              aria-label="Default project directory"
            />
          </div>
          <TugLabel size="sm" emphasis="calm" className="settings-general-hint">
            {missing
              ? "This folder doesn't exist yet — it will be created the first time Tug needs it."
              : "Where Tug looks when no session card says otherwise: Open Quickly with nothing open, and the new-session path when there are no recent projects."}
          </TugLabel>
        </TugBox>

        <TugBox
          label="Briefs Directory"
          labelPosition="legend"
          variant="bordered"
          className="settings-general-group"
        >
          <div
            className="settings-general-field"
            data-testid="settings-briefs-dir-field"
          >
            <TugFileChooser
              value={briefsValue}
              onChange={setBriefsDraft}
              base={home ?? "/"}
              kind="directory"
              onSettle={settleBriefs}
              placeholder={DEFAULT_BRIEFS_TEMPLATE}
              aria-label="Briefs directory"
            />
          </div>
          <TugLabel size="sm" emphasis="calm" className="settings-general-hint">
            Where a brief is written when you ask for one. Unset means briefs/
            inside the project; {"{project_dir}"} stands for the project.
          </TugLabel>
        </TugBox>

      </div>
    </ResponderScope>
  );
}
