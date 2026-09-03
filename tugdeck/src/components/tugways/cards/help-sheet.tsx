/**
 * help-sheet.tsx — the `/help` tabbed sheet ([#step-13b2]).
 *
 * Modeled on the Claude Code terminal's `/help` ([D16]) as a card-scoped
 * overlay ([D15]) with two tabs:
 *  - **General** — what Dev is, the useful keyboard shortcuts, and a pointer
 *    to the unsupported-commands doc.
 *  - **Commands** — the built-in slash commands.
 *
 * The command list is projected from the card's `SessionMetadataStore` catalog
 * through the [D14] allowlist ({@link projectHelpCommands}): never a hidden
 * command, always the [D23] local commands, and built-in commands only — plugin
 * / bundled-marketplace skills and agents are not this project's own commands,
 * so they're left to the slash popup and the `/agents` sheet. The General-tab
 * copy is static ({@link help-content}).
 *
 * Compositional — composes `TugSheet` (via the card's shared `showSheet`),
 * `TugSheetScaffold`, `TugTabBar` (a fixed, non-closable tab set, the
 * established in-sheet tab idiom from `permission-rules-editor`), `TugListRow`,
 * `TugPushButton`; composed children keep their own tokens ([L20]).
 *
 * Laws: [L02] store reads via `useSyncExternalStore`, [L06] appearance via CSS,
 *       [L07] resolve the doc path fresh at open time, [L11] the tab bar emits
 *       `selectTab` through the chain, [L20] composed children keep tokens.
 * Decisions: [D04] SessionMetadataStore hub, [D15] pane sheets are overlays,
 *       [D16] `/help` is a tabbed sheet, [D23] local-command dispatch.
 *
 * @module components/tugways/cards/help-sheet
 */

import "./help-sheet.css";

import React, { useId, useMemo, useState, useSyncExternalStore } from "react";

import { TugListRow } from "@/components/tugways/tug-list-row";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
} from "@/components/tugways/tug-list-view";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import { TugSheetScaffold } from "@/components/tugways/tug-sheet-scaffold";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import { TugTabBar } from "@/components/tugways/tug-tab-bar";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import type { CardState } from "@/layout-tree";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import {
  HELP_INTRO,
  HELP_SHORTCUTS,
  UNSUPPORTED_COMMANDS_DOC_PATH,
  type HelpCommandEntry,
  projectHelpCommands,
} from "@/lib/help-content";
import { openPathInOS } from "@/lib/os-open";
import type {
  SessionMetadataSnapshot,
  SessionMetadataStore,
} from "@/lib/session-metadata-store";
import { MODAL_REST_LINE } from "./modal-rest-line";

// ---------------------------------------------------------------------------
// Tabs — a fixed, non-closable in-sheet tab set ([permission-rules-editor] idiom)
// ---------------------------------------------------------------------------

type HelpTabId = "general" | "commands";

interface HelpTabSpec {
  readonly id: HelpTabId;
  readonly label: string;
}

const TABS: readonly HelpTabSpec[] = [
  { id: "general", label: "General" },
  { id: "commands", label: "Commands" },
];

/**
 * The tabs as `TugTabBar` cards: fixed and non-closable (`closable: false` → no
 * per-tab ×; the bar is `addable={false}` → no `[+]`). The `componentId` is a
 * non-registered sentinel — these are panel tabs, not deck cards.
 */
const TAB_CARDS: readonly CardState[] = TABS.map((spec) => ({
  id: spec.id,
  componentId: "help-tab",
  title: spec.label,
  closable: false,
}));

// ---------------------------------------------------------------------------
// useHelpSheet — the card-hosted /help sheet
// ---------------------------------------------------------------------------

export interface UseHelpSheetArgs {
  /** Card whose session binding supplies the project root for the doc link. */
  cardId: string;
  /** Supplies the command catalog + session version / model / cwd. */
  sessionMetadataStore: SessionMetadataStore;
  /** The card's shared sheet host (`useTugSheet().showSheet`). */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
}

export interface HelpSheetController {
  /** Present the `/help` sheet. */
  openHelpSheet: () => void;
}

/** Join the project root and the doc's project-relative path; `null` if no root. */
function resolveDocPath(projectDir: string | null): string | null {
  if (projectDir === null || projectDir === "") return null;
  return `${projectDir.replace(/\/+$/, "")}/${UNSUPPORTED_COMMANDS_DOC_PATH}`;
}

export function useHelpSheet({
  cardId,
  sessionMetadataStore,
  showSheet,
}: UseHelpSheetArgs): HelpSheetController {
  const openHelpSheet = React.useCallback(() => {
    // Resolve the doc path fresh at open time ([L07]): the card's bind-time
    // project root (known before claude's first metadata frame), falling back
    // to the live session cwd. With neither known the General tab shows the
    // path as plain text instead of an opener.
    const binding = cardSessionBindingStore.getBinding(cardId);
    const projectDir =
      binding?.projectDir ?? sessionMetadataStore.getSnapshot().cwd ?? null;
    const docPath = resolveDocPath(projectDir);
    void showSheet({
      title: "Help",
      icon: "CircleQuestionMark",
      displayWidth: "xl",
      presentation: "rise",
      bottomAnchorSelector: MODAL_REST_LINE,
      content: (close) => (
        <HelpSheetBody
          sessionMetadataStore={sessionMetadataStore}
          docPath={docPath}
          onClose={close}
        />
      ),
    });
  }, [cardId, sessionMetadataStore, showSheet]);

  return { openHelpSheet };
}

// ---------------------------------------------------------------------------
// Sheet body — tab bar + active panel + Done
// ---------------------------------------------------------------------------

interface HelpSheetBodyProps {
  sessionMetadataStore: SessionMetadataStore;
  /** Absolute path to the unsupported-commands doc, or `null` if unresolved. */
  docPath: string | null;
  onClose: (value?: string) => void;
}

function HelpSheetBody({
  sessionMetadataStore,
  docPath,
  onClose,
}: HelpSheetBodyProps): React.ReactElement {
  const meta = useSyncExternalStore(
    sessionMetadataStore.subscribe,
    sessionMetadataStore.getSnapshot,
  );
  const commands = useMemo(
    () => projectHelpCommands(meta.slashCommands),
    [meta.slashCommands],
  );

  const [tab, setTab] = useState<HelpTabId>("general");

  // TugTabBar dispatches `selectTab` through the chain to this responder ([L11]).
  const tabBarId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    selectTab: { [tabBarId]: (id: string) => setTab(id as HelpTabId) },
  });

  // Author the controls into the sheet's trapped focus mode: Tab walks the tab
  // bar → Done, with Done seeded as the live default (filled+ring) on open.
  const focusGroup = useId();
  const TABBAR_ORDER = 0;
  const DONE_ORDER = 1;
  useSeedKeyView(`${focusGroup}:${DONE_ORDER}`);

  return (
    <ResponderScope>
      <TugSheetScaffold
        className="help-sheet"
        header={
          <TugTabBar
            stackId="help"
            cards={TAB_CARDS}
            activeCardId={tab}
            senderId={tabBarId}
            addable={false}
            className="help-sheet-tabs"
            ref={responderRef as (el: HTMLDivElement | null) => void}
            focusGroup={focusGroup}
            focusOrder={TABBAR_ORDER}
          />
        }
        footer={
          <div className="tug-sheet-actions">
            <TugPushButton
              size="sm"
              emphasis="primary"
              onClick={() => onClose()}
              data-testid="help-done"
              focusGroup={focusGroup}
              focusOrder={DONE_ORDER}
            >
              Done
            </TugPushButton>
          </div>
        }
      >
        {tab === "general" ? (
          <GeneralPanel docPath={docPath} />
        ) : (
          <CommandsPanel meta={meta} entries={commands} />
        )}
      </TugSheetScaffold>
    </ResponderScope>
  );
}

// ---------------------------------------------------------------------------
// General panel — intro, shortcuts, unsupported-commands link
// ---------------------------------------------------------------------------

function GeneralPanel({ docPath }: { docPath: string | null }): React.ReactElement {
  return (
    <div className="help-sheet-general" data-testid="help-general">
      <p className="help-sheet-intro">{HELP_INTRO}</p>

      <div className="help-sheet-section-title">Shortcuts</div>
      <dl className="help-sheet-shortcuts">
        {HELP_SHORTCUTS.map((shortcut) => (
          <div className="help-sheet-shortcut" key={shortcut.keys}>
            <dt>
              <kbd>{shortcut.keys}</kbd>
            </dt>
            <dd>{shortcut.label}</dd>
          </div>
        ))}
      </dl>

      <p className="help-sheet-doc-note">
        Some terminal commands have no useful behavior here.{" "}
        {docPath !== null ? (
          <TugPushButton
            emphasis="ghost"
            size="sm"
            onClick={() => openPathInOS(docPath, "file")}
            data-testid="help-doc-link"
          >
            See the unsupported-commands list
          </TugPushButton>
        ) : (
          <span className="help-sheet-doc-path">{UNSUPPORTED_COMMANDS_DOC_PATH}</span>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commands panel — session header + the built-in command list
// ---------------------------------------------------------------------------

/** Resolve the active model's display name, falling back to its raw value. */
function modelDisplayName(meta: SessionMetadataSnapshot): string | null {
  if (meta.model === null) return null;
  return (
    meta.models.find((m) => m.value === meta.model)?.displayName ?? meta.model
  );
}

function CommandsPanel({
  meta,
  entries,
}: {
  meta: SessionMetadataSnapshot;
  entries: readonly HelpCommandEntry[];
}): React.ReactElement {
  const model = modelDisplayName(meta);
  return (
    <div data-testid="help-commands">
      <div className="help-sheet-meta" data-testid="help-session-meta">
        {meta.version !== null && (
          <span className="help-sheet-meta-version">Claude Code {meta.version}</span>
        )}
        {model !== null && <span>{model}</span>}
        {meta.cwd !== null && <span className="help-sheet-meta-cwd">{meta.cwd}</span>}
      </div>
      <CommandListPanel
        entries={entries}
        emptyMessage="No commands are available yet."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Command list panel — a read-only (non-interactive) command list
// ---------------------------------------------------------------------------

/**
 * Static, single-section data source over a command list. The entries array is
 * stable per render (memoized upstream), so `subscribe` is a no-op and
 * `getVersion` returns the array reference.
 */
class HelpCommandsDataSource implements TugListViewDataSource {
  private readonly entries: readonly HelpCommandEntry[];

  constructor(entries: readonly HelpCommandEntry[]) {
    this.entries = entries;
  }

  numberOfItems(): number {
    return this.entries.length;
  }

  idForIndex(index: number): string {
    return this.entries[index].name;
  }

  kindForIndex(): string {
    return "command";
  }

  /** Cell-renderer accessor — the entry at `index`. */
  entryAt(index: number): HelpCommandEntry {
    return this.entries[index];
  }

  subscribe(): () => void {
    return () => {};
  }

  getVersion(): unknown {
    return this.entries;
  }
}

const HelpCommandCell: TugListViewCellRenderer<HelpCommandsDataSource> =
  function HelpCommandCell({
    index,
    dataSource,
  }: TugListViewCellProps<HelpCommandsDataSource>): React.ReactElement {
    const entry = dataSource.entryAt(index);
    return (
      <TugListRow
        variant="flush"
        title={`/${entry.name}`}
        subtitle={entry.description || undefined}
        data-testid="help-command-row"
        data-command={entry.name}
      />
    );
  };

const HELP_COMMAND_CELL_RENDERERS: Record<
  string,
  TugListViewCellRenderer<HelpCommandsDataSource>
> = { command: HelpCommandCell };

function CommandListPanel({
  entries,
  emptyMessage,
}: {
  entries: readonly HelpCommandEntry[];
  emptyMessage: string;
}): React.ReactElement {
  const dataSource = useMemo(() => new HelpCommandsDataSource(entries), [entries]);
  if (entries.length === 0) {
    return (
      <div className="help-sheet-empty" role="status">
        {emptyMessage}
      </div>
    );
  }
  return (
    <TugListView<HelpCommandsDataSource>
      dataSource={dataSource}
      cellRenderers={HELP_COMMAND_CELL_RENDERERS}
      rowLayout="flush"
      inline
      interactive={false}
      className="help-sheet-commands"
    />
  );
}
