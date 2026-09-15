/**
 * The project path the Session picker opens on, before the user has touched
 * the field.
 *
 * It lives in its own module rather than beside `SessionProjectPickerForm`
 * because `session-card.tsx` is a frozen Fast Refresh boundary
 * (`src/lib/__tests__/fast-refresh-boundary.test.ts`): a runtime non-component
 * export there re-mixes the boundary and puts a full page reload back into the
 * transcript spine.
 */

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
