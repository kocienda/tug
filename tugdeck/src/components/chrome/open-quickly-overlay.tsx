/**
 * open-quickly-overlay.tsx — the deck-global Open Quickly dialog.
 *
 * Mounted once at the deck level. It watches {@link getOpenQuicklyOpen}
 * ([L02] via `useSyncExternalStore`); while open it stands up a live
 * {@link FileTreeStore} against the real connection — the same file-search
 * backend the composer's `@` completion uses — and feeds its provider to a
 * {@link TugModalInputDialog}. Choosing a row opens that file through the one
 * {@link openFileInCard} entry point (so it also lands in Open Recent);
 * dismissing just closes the dialog.
 *
 * The search root is the frontmost card's project when one is bound. With
 * nothing bound — an empty deck, or a deck of picker-state cards — it is the
 * user's default project directory, acquired as a browse hold through
 * {@link acquireDefaultWorkspace} so tugcast will route FILETREE queries to
 * it. That acquisition is asynchronous: the dialog opens immediately with the
 * empty provider and fills in when it lands. A bound card never waits.
 *
 * The root is re-pointed from a {@link TugFileChooser} row above the input —
 * the same three-part path field the session picker's *Project path* uses, with
 * the frontmost binding, the default directory, and recent projects as its
 * seed. Re-scoping happens only when the field **settles** on something new:
 * a half-typed path is not a directory, and the combo box also settles on a
 * plain blur, so the changed-only guard is what keeps a Tab through the row
 * from costing a probe round trip and a bounced key view ([P09] of the
 * modal-input-dialog plan).
 *
 * The query passes through {@link parseFileLocationQuery} on its way to the
 * provider: `tug-list-view.tsx:123` searches for the path and opens on line
 * 123, and an absolute path inside the project collapses to the relative
 * form the index keys on.
 *
 * The FileTreeStore is built and torn down per open session: the inner
 * body mounts only while open, so its `useEffect` owns the store's
 * lifetime and no WebSocket subscription lingers when the dialog is closed.
 *
 * @module components/chrome/open-quickly-overlay
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import {
  TugModalInputDialog,
  MODAL_INPUT_DIALOG_FOCUS_GROUP,
  MODAL_INPUT_DIALOG_FIELD_ORDER,
  useModalInputDialogPanel,
} from "@/components/tugways/tug-modal-input-dialog";
import { TugFileChooser } from "@/components/tugways/tug-file-chooser";
import type { TugComboBoxItem } from "@/components/tugways/tug-combo-box";
import { useFocusManager } from "@/components/tugways/use-focusable";
import { probeDirs } from "@/lib/dir-existence";
import { caseInsensitiveSubstring } from "@/lib/text-match";
import type { TaggedValue, TugbankClient } from "@/lib/tugbank-client";
import { FeedStore } from "@/lib/feed-store";
import { FeedId } from "@/protocol";
import {
  FileTreeStore,
  resolveAgainstRoot,
  workspaceFeedFilter,
} from "@/lib/filetree-store";
import { getAppLifecycle } from "@/lib/app-lifecycle";
import { getConnection } from "@/lib/connection-singleton";
import { parseFileLocationQuery } from "@/lib/file-location-query";
import { getDeckStore } from "@/lib/deck-store-registry";
import { frontmostProjectBinding } from "@/lib/frontmost-project";
import { openFileInCard } from "@/lib/open-file-in-card";
import { useHostFacts } from "@/lib/host-facts-store";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import {
  DEFAULT_PROJECT_PATH_DOMAIN,
  DEFAULT_PROJECT_PATH_KEY,
  resolveProjectPathFrom,
  readSessionRecentProjects,
} from "@/settings-api";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import {
  acquireDefaultWorkspace,
  acquireWorkspace,
  getWorkspace,
  subscribeWorkspaces,
  type AcquiredWorkspace,
} from "@/lib/default-workspace-store";
import type { CompletionItem, CompletionProvider } from "@/lib/tug-text-types";
import {
  closeOpenQuickly,
  getOpenQuicklyOpen,
  subscribeOpenQuickly,
} from "@/lib/open-quickly-store";

/** Provider that returns nothing — no project, or the connection is down. */
const EMPTY_PROVIDER = ((_q: string) => []) as CompletionProvider;

/**
 * How many directories the scope row offers. Enough for the project you are in,
 * your default, and the handful you were in recently — past that the seed stops
 * being a shortcut and starts being a history.
 */
const MAX_ROOT_CANDIDATES = 7;

/**
 * The scope row's stops in the dialog's Tab walk (the query field is order 0),
 * authored in READING order — folder button, path field, chevron, left to
 * right as drawn. The linear order doubles as the arrow order (the liveliness
 * net walks it when no spatial plane is declared), so an order that disagrees
 * with the geometry turns Right on the folder button into a jump somewhere
 * else entirely.
 */
const SCOPE_BROWSE_ORDER = 1;
const SCOPE_FIELD_ORDER = 2;
const SCOPE_CHEVRON_ORDER = 3;

/**
 * The explicit default-project-path setting out of its tugbank entry, or `""`
 * when unset. Module scope so its identity is stable across renders — a fresh
 * closure would re-subscribe {@link useTugbankValue} on every render.
 */
function parseExplicitPath(entry: TaggedValue | undefined): string {
  return entry?.kind === "string" && typeof entry.value === "string"
    ? entry.value
    : "";
}

/** A path's last component — what the input's placeholder names it by. */
function leafName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}

/**
 * A path in the one spelling two paths can be compared in. Not canonical —
 * only the server can say that ([L29]) — just free of the trailing slash the
 * chooser leaves behind while descending.
 */
function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * The directories the scope row offers, in order: the frontmost card's
 * project, the default project directory, then recent projects. Deduped by
 * path and capped, so the seed stays a short list of places rather than a
 * history. Built once per open — see Risk R01.
 */
function rootCandidates(
  bindingDir: string | null,
  defaultPath: string | null,
  client: TugbankClient | null,
): string[] {
  const out: string[] = [];
  const add = (path: string | null): void => {
    if (path !== null && path !== "" && !out.includes(path)) out.push(path);
  };
  add(bindingDir);
  add(defaultPath);
  if (client !== null) {
    for (const path of readSessionRecentProjects(client)) {
      if (out.length >= MAX_ROOT_CANDIDATES) break;
      add(path);
    }
  }
  return out.slice(0, MAX_ROOT_CANDIDATES);
}

/**
 * The frontmost card's project as a search root, or null when nothing is
 * bound. A picker-state card carries a binding with no project yet — that
 * reads as unbound, exactly as it did to the old menu gate.
 */
function frontmostProjectRoot(): AcquiredWorkspace | null {
  const binding = frontmostProjectBinding();
  return binding !== null && binding.projectDir !== "" ? binding : null;
}

/**
 * Render `text` with the matched runs emphasized — weight only, the same
 * emphasis the dialog's own result rows use, so the seed reads as part of the
 * surface it drops out of rather than as a `<mark>`'s highlighter stripe.
 */
function renderSeedHighlight(
  text: string,
  matches: ReadonlyArray<readonly [number, number]>,
): React.ReactNode {
  if (matches.length === 0) return text;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of matches) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <strong key={`m-${start}`} className="tug-modal-input-dialog-match">
        {text.slice(start, end)}
      </strong>,
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

interface ScopeRowProps {
  /** The path text in the field (controlled). */
  value: string;
  /** Working directory relative completions resolve under. */
  base: string;
  /** The candidate directories, already probe-filtered. */
  candidates: readonly string[];
  onChange: (next: string) => void;
  onSettle: (next: string) => void;
}

/**
 * The scope row above the query field. Rendered as the dialog's `header`, so
 * it sits inside the trap and its dropdown portals into the dialog's own panel
 * — a modal Radix content leaves anything portalled outside it pointer-dead,
 * which is what would make a mouse pick in this dropdown do nothing.
 *
 * Its two controls are authored into the dialog's focus group, so the engine's
 * Tab walk reaches them from the query field ([P02] authoring contract): a
 * control with no `focusGroup` is a native-only stop and reads as "Tab skips
 * it".
 */
function OpenQuicklyScopeRow({
  value,
  base,
  candidates,
  onChange,
  onSettle,
}: ScopeRowProps): React.ReactElement {
  const panel = useModalInputDialogPanel();

  // Full paths, not leaf names: the session picker's recents show whole paths,
  // and a leaf alone reads as the same place twice when a checkout and its
  // worktree share a name — which is the whole reason the retired switcher
  // needed a label-disambiguation pass at all.
  const seed = useCallback(
    (query: string): TugComboBoxItem[] => {
      const q = query.trim();
      const items: TugComboBoxItem[] = [];
      for (const path of candidates) {
        const match = caseInsensitiveSubstring(q, path);
        if (q !== "" && match === null) continue;
        items.push({
          value: path,
          label: (
            <span
              data-testid="open-quickly-scope-path"
              title={path}
              aria-label={path}
            >
              {renderSeedHighlight(path, match?.matches ?? [])}
            </span>
          ),
        });
      }
      return items;
    },
    [candidates],
  );

  return (
    <TugFileChooser
      value={value}
      onChange={onChange}
      onSettle={onSettle}
      base={base}
      kind="directory"
      menuMode
      seed={seed}
      aria-label="Search directory"
      placeholder="/path/to/project"
      focusGroup={MODAL_INPUT_DIALOG_FOCUS_GROUP}
      focusOrder={SCOPE_FIELD_ORDER}
      browseFocusOrder={SCOPE_BROWSE_ORDER}
      chevronFocusOrder={SCOPE_CHEVRON_ORDER}
      portalContainer={panel}
      overlaySlot="tug-modal-input-dialog-chooser-overlay"
    />
  );
}

/** The open-session body: builds the file-search stack while mounted. */
function OpenQuicklyBody(): React.ReactElement {
  // The frontmost card's project, captured once when the dialog opens:
  // its `projectDir` is the search root (and the base for absolute paths)
  // and its `workspaceKey` scopes the FILETREE feed. Null → nothing is bound,
  // and the default project directory stands in.
  const bindingRef = useRef(frontmostProjectRoot());

  // The default project directory, resolved (explicit setting, else
  // `<home>/tug`) because this one has to be a real directory to search, not
  // a preference tier. Available whether or not a card is bound — the scope
  // row offers it either way.
  //
  // Read through `useTugbankValue` ([L02]), not a bare `client.get`: the two
  // return the same value, but only the subscribed read re-renders when the
  // setting changes. Settings ▸ General and this dialog are both floating
  // surfaces and are routinely on screen together — an unsubscribed read
  // leaves the dialog searching the directory the user just replaced, with no
  // sign anything happened.
  const hostFacts = useHostFacts();
  const client = getTugbankClient();
  const explicitPath = useTugbankValue(
    DEFAULT_PROJECT_PATH_DOMAIN,
    DEFAULT_PROJECT_PATH_KEY,
    parseExplicitPath,
    "",
  );
  const defaultPath = resolveProjectPathFrom(
    explicitPath,
    hostFacts?.home ?? null,
  );

  // The directory chosen in the scope row, or null while the dialog is still
  // on whatever it opened with. Component-local: it is this dialog instance's
  // UI state and means nothing once it closes.
  const [pickedPath, setPickedPath] = useState<string | null>(null);

  // What the dialog is searching right now.
  const activePath =
    pickedPath ?? bindingRef.current?.projectDir ?? defaultPath;
  const activeIsBinding =
    bindingRef.current !== null &&
    activePath === bindingRef.current.projectDir;

  // tugcast has to register a directory before FILETREE will route queries to
  // it. The bound card's project already is; anything else needs a browse
  // hold. The hold outlives the dialog, so a later ⇧⌘O on the same directory
  // shows results on the first keystroke. Only the default is created if
  // missing — a recent project the user picked is never conjured up.
  useEffect(() => {
    if (activePath === null || activeIsBinding) return;
    if (activePath === defaultPath) acquireDefaultWorkspace(activePath);
    else acquireWorkspace(activePath);
  }, [activePath, activeIsBinding, defaultPath]);

  const acquired = useSyncExternalStore(
    subscribeWorkspaces,
    useCallback(
      (): AcquiredWorkspace | null =>
        activePath === null || activeIsBinding ? null : getWorkspace(activePath),
      [activePath, activeIsBinding],
    ),
  );

  // Whichever root is live. Until an acquisition lands this is null and the
  // dialog renders with the empty provider — a bound card never waits.
  const root: AcquiredWorkspace | null = activeIsBinding
    ? bindingRef.current
    : acquired;
  const projectDir = root?.projectDir ?? null;

  const stackRef = useRef<{
    workspaceKey: string;
    feedStore: FeedStore;
    fileTreeStore: FileTreeStore;
    provider: CompletionProvider;
  } | null>(null);

  if (root !== null && stackRef.current?.workspaceKey !== root.workspaceKey) {
    const connection = getConnection();
    if (connection) {
      const previous = stackRef.current;
      const feedStore = new FeedStore(
        connection,
        [FeedId.FILETREE],
        undefined,
        workspaceFeedFilter(root.workspaceKey),
      );
      const fileTreeStore = new FileTreeStore(
        feedStore,
        FeedId.FILETREE,
        root.projectDir,
      );
      stackRef.current = {
        workspaceKey: root.workspaceKey,
        feedStore,
        fileTreeStore,
        provider: fileTreeStore.getFileCompletionProvider(),
      };
      if (previous !== null) {
        previous.fileTreeStore.dispose();
        previous.feedStore.dispose();
      }
    }
  }

  useEffect(() => {
    return () => {
      const stack = stackRef.current;
      if (stack) {
        stack.fileTreeStore.dispose();
        stack.feedStore.dispose();
        stackRef.current = null;
      }
    };
  }, []);

  // The app going inactive dismisses. A launcher is a transient act on the
  // frontmost window; leaving it up behind a switched-away app strands it over
  // whatever the user comes back to. That is launcher semantics rather than
  // modal semantics — an alert must survive an app switch — so it lives here,
  // at the consumer, and not in the dialog primitive. Read from the app's own
  // lifecycle channel (`applicationWillResignActive`, forwarded by the real
  // `AppDelegate`) rather than a `window` blur, which also fires for focus
  // moving inside the app.
  useEffect(() => {
    const lifecycle = getAppLifecycle();
    if (lifecycle === null) return;
    return lifecycle.observeApplicationWillResignActive(() =>
      closeOpenQuickly(),
    );
  }, []);

  // The line carried by the current query's `file:line` suffix, if any.
  // Written by the provider wrapper below on every keystroke, read at commit.
  const lineRef = useRef<number | undefined>(undefined);

  // The dialog owns the raw query; the file index only knows project-relative
  // paths. This wrapper sits between them: it splits off `:line` (and any
  // `:col`) and relativizes an absolute paste before the search, so the
  // clipboard forms people actually have — `tug-list-view.tsx:123`, a
  // compiler diagnostic, an absolute path from the shell — resolve to a row.
  // Rebuilt whenever the stack is — the wrapper closes over the live base
  // provider, so a root swap that leaves it stale would keep searching the
  // disposed workspace.
  const provider = useMemo<CompletionProvider>(() => {
    const base = stackRef.current?.provider ?? EMPTY_PROVIDER;
    const wrapped = ((raw: string) => {
      const { search, line } = parseFileLocationQuery(raw, projectDir);
      lineRef.current = line;
      return base(search);
    }) as CompletionProvider;
    if (base.subscribe !== undefined) {
      wrapped.subscribe = (listener: () => void) => base.subscribe!(listener);
    }
    return wrapped;
  }, [projectDir, root?.workspaceKey]);

  const commit = (item: CompletionItem): void => {
    const relative = item.atom.value;
    const store = getDeckStore();
    if (
      store !== null &&
      projectDir !== null &&
      typeof relative === "string" &&
      relative !== ""
    ) {
      openFileInCard(
        store,
        resolveAgainstRoot(projectDir, relative),
        lineRef.current,
      );
    }
    closeOpenQuickly();
  };

  // ---- The scope row's candidates ----
  //
  // The candidate list is the frontmost binding, the default directory, then
  // recent projects. It is NOT re-derived per keystroke (Risk R01) — that
  // would race deck reordering under the user's hands — but it IS rebuilt
  // when the default project directory changes, because that change is the
  // user's own explicit act in Settings ▸ General and the seed must not go on
  // offering the directory they just replaced.
  //
  // The round trip does double duty. It drops directories that no longer
  // exist, and it collapses spellings that name the same directory: the same
  // tree reached through a mount and its symlink is two entries in recents but
  // one place, and the seed must not offer it twice. Only the server can say
  // they are the same ([L29]), so the answer comes back with the existence
  // check rather than being guessed here.
  const [candidates, setCandidates] = useState<string[]>(() =>
    rootCandidates(bindingRef.current?.projectDir ?? null, defaultPath, client),
  );
  useEffect(() => {
    const seeded = rootCandidates(
      bindingRef.current?.projectDir ?? null,
      defaultPath,
      client,
    );
    setCandidates(seeded);
    let cancelled = false;
    void probeDirs(seeded).then(({ exists, canonical }) => {
      if (cancelled) return;
      const seen = new Set<string>();
      setCandidates(
        seeded.filter((path) => {
          // Absent from the map means unknown (probe failure, or past the
          // server's batch cap) — keep those, like the picker does.
          if (exists[path] === false) return false;
          // Unresolved paths fall back to their own spelling as identity, so
          // a probe failure degrades to the old string dedup rather than
          // collapsing everything into one entry.
          const identity = canonical[path] ?? path.replace(/\/+$/, "");
          if (seen.has(identity)) return false;
          seen.add(identity);
          return true;
        }),
      );
    });
    return () => {
      cancelled = true;
    };
    // `client` is the process-long singleton and `bindingRef` is captured at
    // open; the default directory is the only thing here that moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultPath]);

  // ---- Re-scoping ----
  //
  // The chooser's text, once the user has touched it. Null means "show
  // whatever the dialog is pointed at", so the field tracks an `activePath`
  // that is still resolving rather than freezing an empty string.
  const [scopeText, setScopeText] = useState<string | null>(null);
  const scopeValue = scopeText ?? activePath ?? "";

  const focusManager = useFocusManager();
  // Read inside the probe's continuation, where a render-time value would be
  // the one from the keystroke that started it.
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const aliveRef = useRef(true);
  useEffect(() => {
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // A settle is not necessarily a choice. `TugComboBox` settles on blur as
  // well as on accept / Enter / the native picker returning, so the Tab walk
  // from this field to Browse… settles the unchanged path on its way past.
  // Comparing first is therefore load-bearing, not tidiness: without it that
  // Tab would fire a probe round trip and then re-seed the key view back onto
  // the query field, and the walk would appear to skip Browse… entirely
  // ([P09]).
  const onScopeSettle = useCallback(
    (raw: string) => {
      const settled = trimTrailingSlash(raw.trim());
      const current = trimTrailingSlash(activePathRef.current ?? "");
      if (settled === "") return;
      if (settled === current) return;
      // Both paths, one round trip. Comparing the typed spelling against the
      // live scope is not enough to know whether anything changed: only the
      // server can say two spellings name one directory ([L29]), and a scope
      // reached through a symlink (every temp directory on macOS, for one)
      // canonicalizes to something the field never held. Without the
      // canonical-to-canonical compare the first Tab through the row would
      // "change" the scope to the same place under another name and bounce the
      // key view back to the query field.
      void probeDirs([settled, current]).then(({ exists, canonical }) => {
        if (!aliveRef.current) return;
        // A path that is not there is not a scope. The field keeps the text
        // the user typed — it is their edit, not ours to revert — and the
        // search stays where it was.
        if (exists[settled] === false) return;
        const resolved = trimTrailingSlash(canonical[settled] ?? settled);
        const live = trimTrailingSlash(canonical[current] ?? current);
        if (resolved === live) return;
        setPickedPath(resolved);
        // The field shows what the search is actually scoped to — the server's
        // canonical answer, which may not be the spelling that was typed.
        setScopeText(resolved);
        // The user's next act after choosing a scope is typing a filename, so
        // the keyboard goes back to the query field. An engine placement, not
        // a raw `.focus()`: the field is a text stop, so the placement grants
        // the caret ([P12]).
        focusManager?.place(
          null,
          {
            kind: "focus-key",
            focusKey: `${MODAL_INPUT_DIALOG_FOCUS_GROUP}:${MODAL_INPUT_DIALOG_FIELD_ORDER}`,
          },
          { modality: "keyboard" },
        );
      });
    },
    [focusManager],
  );

  // The active root's leaf directory name — "Open Quickly in tugtool" reads
  // cleaner than the whole absolute path. Taken from the path the dialog is
  // pointed at rather than the acquired root, so the placeholder names the
  // picked directory while its acquisition is still in flight.
  const projectLeaf = leafName(activePath ?? projectDir ?? "");

  // What an empty result list means, answered at the moment it is rendered.
  // A directory Tug just created for you is genuinely empty, and a blank
  // panel there reads as a hang rather than as an answer — so say so. Before
  // the search backend has answered there is nothing to report yet, and the
  // panel stays bare rather than flashing "no files" at a directory that has
  // plenty.
  const emptyLabel = useCallback((): string | null => {
    const store = stackRef.current?.fileTreeStore;
    if (store === undefined || !store.hasResponded()) return null;
    if (store.getSnapshot().query !== "") return `No files matching that name`;
    return projectLeaf !== ""
      ? `No files in ${projectLeaf}`
      : "This folder is empty";
  }, [projectLeaf]);

  return (
    <TugModalInputDialog
      placeholder={
        projectLeaf !== "" ? `Open Quickly in ${projectLeaf}` : "Open Quickly"
      }
      provider={provider}
      onCommit={commit}
      onDismiss={closeOpenQuickly}
      emptyLabel={emptyLabel}
      // A launcher, not an alert: a click outside is the user saying "never
      // mind". The overlay swallows it either way, so nothing beneath the
      // dialog activates.
      dismissOnOutsideClick
      header={
        <OpenQuicklyScopeRow
          value={scopeValue}
          base={activePath !== null && activePath !== "" ? activePath : "/"}
          candidates={candidates}
          onChange={setScopeText}
          onSettle={onScopeSettle}
        />
      }
    />
  );
}

/** Deck-global mount: renders the dialog only while Open Quickly is open. */
export function OpenQuicklyOverlay(): React.ReactElement | null {
  const open = useSyncExternalStore(subscribeOpenQuickly, getOpenQuicklyOpen);
  if (!open) return null;
  return <OpenQuicklyBody />;
}
