/**
 * The project path the Session picker opens on, before the user has touched
 * the field — and the one read of it that happens OUTSIDE a render.
 *
 * It lives in its own module rather than beside `SessionProjectPickerForm`
 * because `session-card.tsx` and `session-picker-form.tsx` are frozen Fast
 * Refresh boundaries (`src/lib/__tests__/fast-refresh-boundary.test.ts`): a
 * runtime non-component export there re-mixes the boundary and puts a full
 * page reload back into the transcript spine.
 */

import type { TaggedValue } from "@/lib/tugbank-client";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import { hostFactsStore } from "@/lib/host-facts-store";
import {
  DEFAULT_PROJECT_PATH_DOMAIN,
  DEFAULT_PROJECT_PATH_KEY,
} from "@/settings-api";

/** Where the deck keeps the user's recently opened project paths. */
export const RECENT_PROJECTS_DOMAIN = "dev.tugapp.dev";
export const RECENT_PROJECTS_KEY = "recent-projects";

/**
 * Where the Swift host writes the path it suggests at every launch — the repo
 * source tree on debug builds, `$HOME` on release.
 */
export const INITIAL_PROJECT_PATH_DOMAIN = "dev.tugapp.app";
export const INITIAL_PROJECT_PATH_KEY = "initial-project-path";

/**
 * Pure parser for the `dev.tugapp.dev / recent-projects` tagged-value
 * entry. Mirrors `readSessionRecentProjects` in shape — split out so the
 * picker can subscribe to live updates via `useTugbankValue` instead of
 * reading once into `useState` (an L02 violation when external state
 * is copied into React state, even via a lazy initial value).
 */
export function parseRecents(entry: TaggedValue | undefined): string[] {
  if (!entry || entry.kind !== "json" || entry.value === undefined) return [];
  const raw = entry.value as { paths?: unknown } | null;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.paths)) return [];
  return raw.paths.filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
}

/**
 * Parse a tugbank string value. The Swift host writes
 * `dev.tugapp.app/initial-project-path` as `{ kind: "string" }` via
 * `TugbankClient.setString` — empty string when the key is missing
 * or shaped unexpectedly.
 */
export function parseString(entry: TaggedValue | undefined): string {
  if (!entry || entry.kind !== "string" || typeof entry.value !== "string")
    return "";
  return entry.value;
}

/**
 * The seed precedence: the most-recent project, then the user's default project
 * directory, then the Swift-provided hint, then the backend home directory,
 * then nothing.
 *
 * The default tier reads the *explicit* setting, never the `<home>/tug`
 * resolution: an unset key falls through to the Swift hint (which seeds the
 * repo source tree on debug builds) instead of being shadowed by a computed
 * path the user never chose.
 *
 * It is a pure function called at render rather than an effect writing state
 * ([P10], [L02]) because the picker's FIRST render has to carry the path the
 * picker will be drawn with. A picker rendered at the empty path lists no
 * sessions and stands some 174px shorter than the one the user sees, and the
 * height read before a card commits is read off that first render.
 */
export function seedPathFrom(
  recents: readonly string[],
  defaultProjectPath: string,
  initialProjectPath: string,
  homeDir: string | undefined,
): string {
  if (recents.length > 0) return recents[0];
  if (defaultProjectPath !== "") return defaultProjectPath;
  if (initialProjectPath !== "") return initialProjectPath;
  return homeDir ?? "";
}

/**
 * The seed path as it stands right now, read straight off the stores the
 * picker's render reads through hooks — the same four inputs through the same
 * precedence, so the path the deck readies a listing for before it measures
 * the picker is the path the picker then opens on.
 *
 * Called by the Session card's opening form ([Spec S02]) from outside any
 * render, which is why it reads the tugbank client and the host-facts store
 * directly rather than through `useTugbankValue` / `useHostFacts`.
 */
export function readSeedPath(): string {
  const client = getTugbankClient();
  return seedPathFrom(
    client === null
      ? []
      : parseRecents(client.get(RECENT_PROJECTS_DOMAIN, RECENT_PROJECTS_KEY)),
    client === null
      ? ""
      : parseString(
          client.get(DEFAULT_PROJECT_PATH_DOMAIN, DEFAULT_PROJECT_PATH_KEY),
        ),
    client === null
      ? ""
      : parseString(
          client.get(INITIAL_PROJECT_PATH_DOMAIN, INITIAL_PROJECT_PATH_KEY),
        ),
    hostFactsStore.getSnapshot()?.home,
  );
}
