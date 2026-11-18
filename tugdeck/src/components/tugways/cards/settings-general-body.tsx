/**
 * settings-general-body.tsx — the General settings panel.
 *
 * App-wide preferences that belong to the app itself rather than to a card
 * type. Two directory rows and two choices. The **default project directory** —
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
 * The first choice is how a card **masthead** spells the file it names — the full
 * path, or the path relative to the open project it sits in. It belongs to
 * no one card type: the text card, the file view and the diff pop-out all
 * draw their path through the one masthead (`lib/masthead-path.ts`).
 *
 * The second choice is how long **every tooltip** waits before it appears —
 * the house tooltips, the chart bubble and the OS tooltips of a `title`
 * attribute alike — offered as times and Never, and stored in milliseconds
 * (`lib/tooltip-delay.ts`).
 *
 * The last group is **Session Notifications**: how Tug asks for the user when
 * a session card they are not watching finishes its turn, or needs their
 * answer to go on. Each of the two events has its own dock bounce — Continued,
 * Once or Never — and its own switch for a macOS notification beside it. The
 * shell's watcher (`lib/session-notify.ts`) reads both at the moment the event
 * happens, and the host acts on them only while Tug is in the background.
 * While either switch is on, a status line under the rows says what macOS
 * will do with a notification — not asked, turned off, no banners, or
 * allowed — with the one button that state calls for, and Send Test posts
 * one the way a session's is posted and reports whether macOS delivered it
 * (`lib/notify-status.ts`). Turning a switch on asks
 * macOS for permission then, while the user is looking at the setting.
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
  useId,
  useRef,
  useState,
} from "react";
import { TugSettingsGroup } from "../tug-settings-group";
import { TugChoiceGroup } from "../tug-choice-group";
import { TugSwitch } from "../tug-switch";
import { TugLabel } from "../tug-label";
import { TugPushButton } from "../tug-push-button";
import { TugFileChooser, useFileChooserHost } from "../tug-file-chooser";
import { useResponderForm } from "../use-responder-form";
import { useHostFacts } from "@/lib/host-facts-store";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import { probeDirExistence } from "@/lib/dir-existence";
import { getAppLifecycle } from "@/lib/app-lifecycle";
import { askNotify, notifyStatusLine, notifyTestLines, useNotifyStatus } from "@/lib/notify-status";
import {
  DEFAULT_PROJECT_PATH_DOMAIN,
  DEFAULT_PROJECT_PATH_KEY,
  DEFAULT_PROJECT_DIR_LEAF,
  putDefaultProjectPath,
  BRIEFS_PATH_DOMAIN,
  BRIEFS_PATH_KEY,
  DEFAULT_BRIEFS_TEMPLATE,
  putBriefsPath,
  MASTHEAD_PATHS_DOMAIN,
  MASTHEAD_PATHS_KEY,
  parseMastheadPathStyle,
  putMastheadPathStyle,
  DEFAULT_TOOLTIP_DELAY_MS,
  TOOLTIP_DELAY_DOMAIN,
  TOOLTIP_DELAY_KEY,
  parseTooltipDelay,
  putTooltipDelay,
  SESSION_NOTIFY_DOMAIN,
  SESSION_NOTIFY_BOUNCE_KEYS,
  SESSION_NOTIFY_BANNER_KEYS,
  DEFAULT_DOCK_BOUNCE,
  parseDockBounce,
  parseNotifyBanner,
  putDockBounce,
  putNotifyBanner,
  type DockBounce,
  type SessionNotifyEvent,
} from "@/settings-api";
import { TOOLTIP_DELAY_CHOICES_MS, formatTooltipDelay } from "@/lib/tooltip-delay";
import type { TaggedValue } from "@/lib/tugbank-client";
import "./settings-general-body.css";

/** Read the explicit stored path out of a tugbank entry. */
function parseStoredPath(entry: TaggedValue | undefined): string {
  if (entry && entry.kind === "string" && typeof entry.value === "string") {
    return entry.value;
  }
  return "";
}

/** The bounce choices, in the order the row offers them. */
const DOCK_BOUNCE_ITEMS: { value: DockBounce; label: string }[] = [
  { value: "continued", label: "Keep bouncing" },
  { value: "once", label: "Bounce once" },
  { value: "never", label: "Don’t bounce" },
];

/** A stored bounce choice, narrowed back from the choice group's string. */
function asDockBounce(v: string): DockBounce {
  return v === "continued" || v === "once" || v === "never" ? v : DEFAULT_DOCK_BOUNCE;
}

/** One event's two stored choices and the sender ids its controls dispatch with. */
function useSessionNotifySetting(event: SessionNotifyEvent) {
  const bounce = useTugbankValue(
    SESSION_NOTIFY_DOMAIN,
    SESSION_NOTIFY_BOUNCE_KEYS[event],
    parseDockBounce,
    DEFAULT_DOCK_BOUNCE,
  );
  const notification = useTugbankValue(
    SESSION_NOTIFY_DOMAIN,
    SESSION_NOTIFY_BANNER_KEYS[event],
    parseNotifyBanner,
    false,
  );
  return { bounce, notification, bounceId: useId(), notificationId: useId() };
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
  const DraftHost = useFileChooserHost({ onChange: setDraft, onSettle: (path) => settle(path) });
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
  const BriefsHost = useFileChooserHost({
    onChange: setBriefsDraft,
    onSettle: (path) => settleBriefs(path),
  });
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

  const mastheadPaths = useTugbankValue(
    MASTHEAD_PATHS_DOMAIN,
    MASTHEAD_PATHS_KEY,
    parseMastheadPathStyle,
    "full",
  );
  const mastheadPathsId = useId();

  const tooltipDelay = useTugbankValue(
    TOOLTIP_DELAY_DOMAIN,
    TOOLTIP_DELAY_KEY,
    parseTooltipDelay,
    DEFAULT_TOOLTIP_DELAY_MS,
  );
  const tooltipDelayId = useId();

  const notifyComplete = useSessionNotifySetting("complete");
  const notifyInput = useSessionNotifySetting("input");

  // What macOS will do with a notification. Read when the card opens and
  // whenever Tug comes forward again, which is the user returning from
  // System Settings.
  const notifyStatus = useNotifyStatus();
  useEffect(() => {
    askNotify("status");
    return getAppLifecycle()?.observeApplicationDidBecomeActive(() => askNotify("status"));
  }, []);
  const notifyOn = notifyComplete.notification || notifyInput.notification;
  const notifyLine =
    notifyOn && notifyStatus.status !== null ? notifyStatusLine(notifyStatus.status) : null;
  const notifyTest = notifyOn ? notifyTestLines(notifyStatus.test) : null;

  // Turning a switch on is the moment to ask macOS, while the user is here.
  const setNotifyBanner = (event: SessionNotifyEvent, on: boolean) => {
    putNotifyBanner(event, on);
    askNotify(on ? "authorize" : "status");
  };

  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      [mastheadPathsId]: (v: string) =>
        putMastheadPathStyle(v === "project" ? "project" : "full"),
      [tooltipDelayId]: (v: string) => putTooltipDelay(Number(v)),
      [notifyComplete.bounceId]: (v: string) => putDockBounce("complete", asDockBounce(v)),
      [notifyInput.bounceId]: (v: string) => putDockBounce("input", asDockBounce(v)),
    },
    toggle: {
      [notifyComplete.notificationId]: (on: boolean) => setNotifyBanner("complete", on),
      [notifyInput.notificationId]: (on: boolean) => setNotifyBanner("input", on),
    },
  });

  const notifyRows: {
    event: SessionNotifyEvent;
    label: string;
    setting: ReturnType<typeof useSessionNotifySetting>;
  }[] = [
    {
      event: "complete",
      label: "When a session completes",
      setting: notifyComplete,
    },
    {
      event: "input",
      label: "When a session needs your input",
      setting: notifyInput,
    },
  ];

  return (
    <ResponderScope>
      <div
        className="settings-general"
        data-testid="settings-general"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <TugSettingsGroup
          label="Default Project Directory"
          className="settings-general-group"
        >
          <div
            className="settings-general-field"
            data-testid="settings-default-project-dir-field"
          >
            <DraftHost>
            <TugFileChooser size="sm"
              value={value}
              base={value !== "" ? value : home ?? "/"}
              kind="directory"
              placeholder={resolvedFallback}
              aria-label="Default project directory"
            />
            </DraftHost>
          </div>
          <TugLabel size="sm" emphasis="calm" className="settings-general-hint">
            {missing
              ? "This folder doesn't exist yet — it will be created the first time it's needed."
              : "The fallback when no session card says otherwise: Open Quickly with nothing open, and the new-session path when there are no recent projects."}
          </TugLabel>
        </TugSettingsGroup>

        <TugSettingsGroup
          label="Briefs Directory"
          className="settings-general-group"
        >
          <div
            className="settings-general-field"
            data-testid="settings-briefs-dir-field"
          >
            <BriefsHost>
            <TugFileChooser size="sm"
              value={briefsValue}
              base={home ?? "/"}
              kind="directory"
              placeholder={DEFAULT_BRIEFS_TEMPLATE}
              aria-label="Briefs directory"
            />
            </BriefsHost>
          </div>
          <TugLabel size="sm" emphasis="calm" className="settings-general-hint">
            Where a brief is written when you ask for one. Unset means briefs/
            inside the project; {"{project_dir}"} stands for the project.
          </TugLabel>
        </TugSettingsGroup>

        <TugSettingsGroup
          label="Card Masthead Paths"
          className="settings-general-group"
        >
          <div
            className="settings-general-field"
            data-testid="settings-masthead-paths-field"
          >
            <TugChoiceGroup
              size="sm"
              senderId={mastheadPathsId}
              value={mastheadPaths}
              aria-label="Card masthead paths"
              items={[
                { value: "full", label: "Full Path" },
                { value: "project", label: "Project Relative" },
              ]}
            />
          </div>
          <TugLabel size="sm" emphasis="calm" className="settings-general-hint">
            How a text, file or diff card names its file. Project Relative
            writes the path from the open project it sits in; a file outside
            every open project keeps its full path.
          </TugLabel>
        </TugSettingsGroup>

        <TugSettingsGroup
          label="Tooltip Delay"
          className="settings-general-group"
        >
          <div
            className="settings-general-field"
            data-testid="settings-tooltip-delay-field"
          >
            <TugChoiceGroup
              size="sm"
              senderId={tooltipDelayId}
              value={String(tooltipDelay)}
              aria-label="Tooltip delay"
              items={TOOLTIP_DELAY_CHOICES_MS.map((ms) => ({
                value: String(ms),
                label: formatTooltipDelay(ms),
              }))}
            />
          </div>
          <TugLabel size="sm" emphasis="calm" className="settings-general-hint">
            How long the pointer rests on something before its tooltip
            appears; Never turns tooltips off. Chart marks and Layout places
            answer sooner when this is longer than they wait on their own.
          </TugLabel>
        </TugSettingsGroup>

        <TugSettingsGroup
          label="Session Notifications"
          className="settings-general-group"
        >
          {notifyRows.map(({ event, label, setting }) => (
            <div
              key={event}
              className="settings-general-notify-row"
              data-testid={`settings-notify-${event}-field`}
            >
              <TugLabel size="sm" emphasis="strong">{label}</TugLabel>
              <div className="settings-general-notify-controls">
                <TugChoiceGroup
                  size="sm"
                  senderId={setting.bounceId}
                  value={setting.bounce}
                  aria-label={`${label}: bounce dock icon`}
                  items={DOCK_BOUNCE_ITEMS}
                />
                <TugSwitch
                  size="sm"
                  label="Post macOS notification"
                  checked={setting.notification}
                  senderId={setting.notificationId}
                  data-testid={`settings-notify-${event}-notification`}
                />
              </div>
            </div>
          ))}
          {notifyLine !== null ? (
            <div
              className="settings-general-notify-status"
              data-testid="settings-notify-status"
              data-notify-action={notifyLine.action}
            >
              <TugLabel size="sm">{notifyLine.text}</TugLabel>
              <TugPushButton
                size="xs"
                data-testid="settings-notify-status-action"
                disabled={notifyStatus.test.kind === "sending"}
                onClick={() => askNotify(notifyLine.action)}
              >
                {notifyLine.actionLabel}
              </TugPushButton>
              {notifyTest !== null ? (
                <div className="settings-general-notify-test" data-testid="settings-notify-test">
                  {notifyTest.map((sentence) => (
                    <TugLabel key={sentence} size="sm" emphasis="calm" className="settings-general-hint">
                      {sentence}
                    </TugLabel>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="settings-general-notify-hints">
            <TugLabel size="sm" emphasis="calm" className="settings-general-hint">
              Tug doesn’t bounce or notify while it’s the frontmost app.
            </TugLabel>
            <TugLabel size="sm" emphasis="calm" className="settings-general-hint">
              Clicking a notification opens the card for that session.
            </TugLabel>
            <TugLabel size="sm" emphasis="calm" className="settings-general-hint">
              macOS asks for permission when you turn a notification on. A Focus
              can silence notifications unless Tug is allowed in it.
            </TugLabel>
          </div>
        </TugSettingsGroup>

      </div>
    </ResponderScope>
  );
}
