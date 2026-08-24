# Theme Save Format Fix

## Problem Statement

The theme creation flow is broken. When a user creates a new theme from a
prototype (brio or harmony), the save endpoint writes a malformed JSON file to
disk. When this file is later read by `activateThemeOverride` or the startup
plugin, the code crashes with:

```
TypeError: Cannot read properties of undefined (reading 'canvas')
```

This bug was identified during plan review (overviewer OF1, HIGH severity) but
was never properly addressed in the plan or implementation.

## Root Cause

There is a format mismatch between what the client sends to `POST /__themes/save`
and what the server-side theme consumers (`activateThemeOverride`,
`themeOverridePlugin`, `generateThemeCSS`, `deriveTheme`) expect to read from
disk.

### What the client sends

Both save call sites — `NewThemeDialog.handleCreate` (line 1428) and
`performSave` (line 1936) in `gallery-theme-generator-content.tsx` — send:

```typescript
body: JSON.stringify({
  name: recipe.name,
  recipe: JSON.stringify(recipe)   // full ThemeRecipe, stringified
})
```

This produces a request body with exactly two fields:

```json
{
  "name": "my-theme",
  "recipe": "{\"name\":\"my-theme\",\"recipe\":\"dark\",\"surface\":{\"canvas\":{...}},\"text\":{...},\"role\":{...}}"
}
```

The `recipe` field is a **JSON string** containing the entire `ThemeRecipe`
object serialized as text. There are no `surface`, `text`, or `role` fields at
the top level.

### What the server writes to disk

`handleThemesSave` in `vite.config.ts` (line 368) receives the body, casts it
to `ThemeSaveBody`, validates only that `recipe` is a non-empty string (line
399), and writes it to `~/.tugtool/themes/<name>.json`:

```typescript
const normalizedRecipe: ThemeSaveBody = { ...recipe, name: safeName };
fsImpl.writeFileSync(jsonPath, JSON.stringify(normalizedRecipe, null, 2), "utf-8");
```

The spread `{ ...recipe }` copies the two fields from the request body. The
resulting file on disk:

```json
{
  "name": "my-theme",
  "recipe": "{\"name\":\"my-theme\",\"recipe\":\"dark\",\"surface\":{...},...}"
}
```

There are **no** `surface`, `text`, or `role` fields. The actual recipe data is
trapped inside the `recipe` string.

### What consumers expect

Every consumer that reads theme JSON expects a valid `ThemeRecipe`:

```typescript
interface ThemeRecipe {
  name: string;
  recipe: "dark" | "light";
  surface: {
    canvas: ThemeColorSpec;
    grid: ThemeColorSpec;
    frame: ThemeColorSpec;
    card: ThemeColorSpec;
  };
  text: { hue: string; intensity: number };
  role: { tone: number; intensity: number; accent: string; ... };
}
```

The shipped themes (`tugdeck/themes/brio.json`, `harmony.json`) follow this
format exactly. User-authored themes saved via the buggy endpoint do not.

### The crash chain

1. Client sends `{ name, recipe: JSON.stringify(recipe) }` to save endpoint
2. Server writes `{ name, recipe: "<stringified>" }` to disk (no surface/text/role)
3. Save middleware calls `activateThemeOverride(id)` after the write
4. `activateThemeOverride` reads the JSON, does `JSON.parse(raw)` → gets
   `{ name: "my-theme", recipe: "<stringified>" }`
5. Calls `generateThemeCSS(recipe)` which calls `deriveTheme(recipe)`
6. `deriveTheme` does `RECIPE_REGISTRY[recipe.recipe]` — looks up a key that is
   a giant JSON string → returns `undefined`
7. Falls through to `darkRecipe(recipe)` which accesses
   `recipe.surface.canvas` → **crashes** because `surface` is `undefined`

The same crash occurs in the startup plugin's `configResolved` hook when a
user-authored theme is active across a server restart.

Confirmed by examining the actual saved file at `~/.tugtool/themes/d2.json`:
```
recipe type: str (a long JSON string)
has surface: False
```

## The ThemeSaveBody Type Mismatch

The `ThemeSaveBody` interface in `vite.config.ts` (line 220) is misleading:

```typescript
export interface ThemeSaveBody {
  name: string;
  recipe: string;        // described as "string" — allows the stringified recipe
  surface: { ... };      // these fields are declared but NEVER actually sent
  text: { ... };         //   by the client
  role: { ... };
}
```

This interface declares `surface`, `text`, and `role` as required fields, but
the client never sends them. The `as ThemeSaveBody` cast at line 398 silences
TypeScript without runtime validation. The validation at line 399 only checks
`typeof recipe.recipe === "string"`.

## Correct Fix

The on-disk format for user-authored themes must match the shipped theme format:
a valid `ThemeRecipe` with all fields at the top level. This is the **canonical
format** that `deriveTheme`, `generateThemeCSS`, `activateThemeOverride`, and
the startup plugin all expect.

### Strategy: Fix the client

Change both save call sites to send the full `ThemeRecipe` as the request body:

```typescript
// BEFORE (broken):
body: JSON.stringify({ name: recipe.name, recipe: JSON.stringify(recipe) })

// AFTER (correct):
body: JSON.stringify(recipe)
```

The full `ThemeRecipe` object becomes the request body directly. No wrapping, no
stringification of the recipe inside itself.

**Implications:**
- `handleThemesSave` receives a proper `ThemeRecipe` and writes it to disk as-is
- The saved JSON file has the same format as shipped themes
- `activateThemeOverride` reads it and gets a valid `ThemeRecipe` — no unwrapping needed
- The `ThemeSaveBody` interface is replaced with a type matching `ThemeRecipe`

## Detailed Changes Required

### 1. Remove the `description` field from ThemeRecipe

The `description` field is unnecessary cruft. Remove it from:

- **`ThemeRecipe` interface** in `theme-engine.ts` (line 282): delete the field
- **Shipped theme JSON files** (`tugdeck/themes/brio.json`,
  `tugdeck/themes/harmony.json`): remove the `"description"` key
- **CSS header generation** in `theme-engine.ts` (line 2988) and
  `gallery-theme-generator-content.tsx` (line 900): the `@theme-description`
  line in the generated CSS header references `recipe.description` — remove this
  line from both locations
- **`ThemeSaveBody` interface** in `vite.config.ts`: do not include `description`
  in the replacement type
- **Any test data** that includes a `description` field in theme recipes

### 2. Client: gallery-theme-generator-content.tsx

**File:** `tugdeck/src/components/tugways/cards/gallery-theme-generator-content.tsx`

**Change A — NewThemeDialog.handleCreate (around line 1428):**

```typescript
// BEFORE:
body: JSON.stringify({ name: newRecipe.name, recipe: JSON.stringify(newRecipe) })

// AFTER:
body: JSON.stringify(newRecipe)
```

**Change B — performSave (around line 1936):**

```typescript
// BEFORE:
body: JSON.stringify({ name: recipe.name, recipe: JSON.stringify(recipe) })

// AFTER:
body: JSON.stringify(recipe)
```

### 3. Server: vite.config.ts — ThemeSaveBody interface

**File:** `tugdeck/vite.config.ts`

Replace `ThemeSaveBody` (lines 220-243) with a type that matches `ThemeRecipe`.
Since `vite.config.ts` uses lazy `require()` for engine imports (to avoid
circular dependencies), define the interface inline:

```typescript
/** Shape of the JSON body for POST /__themes/save — matches ThemeRecipe. */
interface ThemeSaveBody {
  name: string;
  recipe: string;  // "dark", "light", or future modes — NOT a JSON blob
  surface: {
    canvas: { hue: string; tone: number; intensity: number };
    grid?: { hue: string; tone: number; intensity: number };
    frame?: { hue: string; tone: number; intensity: number };
    card?: { hue: string; tone: number; intensity: number };
  };
  text: { hue: string; intensity: number };
  display?: { hue: string; intensity: number };
  border?: { hue: string; intensity: number };
  role: {
    tone: number;
    intensity: number;
    accent: string;
    action: string;
    agent: string;
    data: string;
    success: string;
    caution: string;
    danger: string;
  };
}
```

Note: `recipe` is typed as `string` (not `"dark" | "light"`) to stay flexible
for future recipe modes. The validation (next section) ensures it's a short
mode name, not a JSON blob.

### 4. Server: vite.config.ts — handleThemesSave validation

**File:** `tugdeck/vite.config.ts`

Update validation in `handleThemesSave` (around line 397-401) to verify the
body is a proper recipe structure, not a wrapper containing a stringified blob:

```typescript
// Validate recipe structure — must be a short mode string, not a JSON blob
if (!b.recipe || typeof b.recipe !== "string") {
  return { status: 400, body: JSON.stringify({ error: "recipe field is required" }) };
}
if (b.recipe.startsWith("{")) {
  return { status: 400, body: JSON.stringify({ error: "recipe must be a mode string (e.g. 'dark'), not a JSON object" }) };
}
if (!b.surface || typeof b.surface !== "object") {
  return { status: 400, body: JSON.stringify({ error: "surface field is required" }) };
}
```

Do NOT hardcode `"dark" | "light"` in the validation. The `RECIPE_REGISTRY` in
`theme-engine.ts` is the source of truth for valid recipe mode names. The
server-side validation only needs to reject obviously malformed input (like a
JSON blob in the recipe field). `deriveTheme` will fail with a clear error if
the mode is unrecognized.

### 5. Server: vite.config.ts — name handling

The filename is a short hash of the theme name. The JSON `name` field is the
user's display name. The hash is opaque — humans never see it.

```typescript
import { createHash } from "node:crypto";
const hash = createHash("sha256").update(name.trim()).digest("hex").slice(0, 8);
const jsonPath = path.join(userDir, `${hash}.json`);
fsImpl.writeFileSync(jsonPath, JSON.stringify(body, null, 2), "utf-8");
```

Remove the `safeName` derivation logic (the lowercase/regex normalization).

The response returns `{ ok: true, name }`. All API surfaces (`setTheme`,
`POST /__themes/activate`, `.tugtool/active-theme`) use the theme name as the
identifier — not the hash. The hash is only for the filename. When looking up
a user theme, scan the directory, read each JSON file's `name` field, and match.
This is a small directory with a handful of files — scanning is fine.

The shipped-theme collision check compares `name.trim().toLowerCase()` against
shipped theme names (also lowercased). No filesystem behavior dependency.

### 6. Save middleware: activate call after save

After `handleThemesSave` returns, the middleware calls
`activateThemeOverride(name)` where `name` is the theme name from the request.
`activateThemeOverride` looks up the theme by scanning the user directory for a
JSON file whose `name` field matches (same scan as `handleThemesList`). Replace
the current direct filename construction (`${themeName}.json`) with the
name-based lookup for user themes. Shipped themes keep direct filename lookup
since their filenames match their names.

### 7. Migration: existing user theme files

Users who created themes before this fix will have JSON files in
`~/.tugtool/themes/` with the broken format. These files will crash
`activateThemeOverride` when loaded.

Add a migration guard in `activateThemeOverride`. After `JSON.parse(raw)`,
detect the legacy format and unwrap:

```typescript
const parsed = JSON.parse(raw);
let recipe: ThemeRecipe;
if (typeof parsed.recipe === "string" && parsed.recipe.startsWith("{")) {
  // Legacy format: recipe field contains a stringified ThemeRecipe.
  // Parse the nested recipe and use it instead.
  try {
    recipe = JSON.parse(parsed.recipe) as ThemeRecipe;
  } catch {
    throw new Error(`Theme '${themeName}' has corrupt recipe data`);
  }
  // Rewrite the file in canonical format so this migration runs once.
  try {
    fsImpl.writeFileSync(jsonPath, JSON.stringify(recipe, null, 2), "utf-8");
  } catch {
    // Migration rewrite failed (permissions, disk, etc.) — not fatal.
    // The parsed recipe is valid and usable for this session.
  }
} else {
  recipe = parsed as ThemeRecipe;
}
```

Detection: `typeof parsed.recipe === "string" && parsed.recipe.startsWith("{")`
is unambiguous — a valid recipe mode like `"dark"` or `"light"` never starts
with `{`. A stringified JSON blob always does.

The migration rewrite is best-effort. If it fails, the theme still works for the
current session. Next load will try the migration again.

**Apply the same guard in the startup plugin's `configResolved` hook** for the
case where a legacy theme is active across a server restart.

The startup plugin also needs the same lookup change as `activateThemeOverride`:
`.tugtool/active-theme` stores the theme name (not a hash), so the plugin must
scan the user themes directory and match by JSON `name` field to find the file.
Shipped themes keep direct filename lookup (`${themeName}.json`) since their
filenames match their names.

### 8. .gitignore: user theme files

User theme files live in `~/.tugtool/themes/` (outside the repo). No gitignore
changes needed for them.

The `tug-theme-override.css` file is already gitignored (step 1 of the previous
plan added it to `tugdeck/.gitignore`). No additional gitignore entries needed.

The `src/generated/theme-canvas-params.ts` file is generated by
`generate-tug-tokens.ts`. Check whether it's gitignored — if not, it should be,
since it's a generated artifact that can be rebuilt from source.

### 9. Tests: the round-trip gap

The fundamental test gap that allowed this bug: the theme-middleware tests
(`makeMinimalSaveBody`) were testing the correct on-disk format, but the
client was never tested to verify it actually sends that format. The
theme-export-import test was testing the broken client format against a mock
fetch, confirming the wrong behavior.

**Add a round-trip integration test** that exercises the actual data path:

```typescript
// In vite-config-activate.test.ts or a new test file:

it("save → activate round trip: saved theme JSON is valid for activateThemeOverride", () => {
  // 1. Call handleThemesSave with a ThemeRecipe body (the way the fixed client sends it)
  const recipe = { name: "test-rt", recipe: "dark", surface: { canvas: { ... } }, ... };
  const saveResult = handleThemesSave(recipe, mockFs, shippedDir, userDir);
  expect(saveResult.status).toBe(200);

  // 2. Find the written file by scanning the directory (filename is a hash, not the name)
  const files = mockFs.readdirSync(userDir).filter((f: string) => f.endsWith(".json"));
  expect(files.length).toBe(1);
  const savedJson = mockFs.readFileSync(path.join(userDir, files[0]), "utf-8");
  const parsed = JSON.parse(savedJson);

  // 3. Verify the saved JSON is a valid ThemeRecipe — not a wrapper with a stringified blob
  expect(parsed.name).toBe("test-rt");
  expect(typeof parsed.recipe).toBe("string");
  expect(parsed.recipe).not.toContain("{");  // not a JSON blob
  expect(parsed.surface).toBeDefined();
  expect(parsed.surface.canvas).toBeDefined();
  expect(parsed.surface.canvas.hue).toBeDefined();

  // 4. Feed the name to activateThemeOverride (it scans the directory to find the file)
  const activateResult = activateThemeOverride("test-rt", mockFs, shippedDir, userDir, overridePath, activeThemePath);
  expect(activateResult.theme).toBe("test-rt");
  expect(activateResult.canvasParams.hue).toBeDefined();
});
```

This test closes the gap: it proves that what `handleThemesSave` writes to disk
is readable by `activateThemeOverride`. If the client format regresses back to
the stringified wrapper, this test will fail because `handleThemesSave` will
either reject it (validation) or the activate step will crash.

**Update existing tests:**

- **`theme-export-import.test.tsx`** save model test: change the request body
  from `{ name, recipe: JSON.stringify(recipe) }` to `JSON.stringify(recipe)`.
  Update assertions to verify `body.recipe` is a mode string, `body.surface`
  is an object. Remove the `JSON.parse(body["recipe"])` assertion.

- **`theme-middleware.test.ts`**: `makeMinimalSaveBody` already uses the correct
  format (`recipe: "dark"`, top-level `surface`). No changes needed, but add
  a negative test: calling `handleThemesSave` with the old broken format
  (`recipe: JSON.stringify(...)`) should return 400.

- **`vite-config-activate.test.ts`**: verify mocked theme JSON uses the correct
  `ThemeRecipe` format. Add a test that `activateThemeOverride` correctly
  migrates a legacy-format file (stringified recipe blob).

### 10. Token generation: generate-tug-tokens.ts

The `THEME_CANVAS_PARAMS` generation reads shipped theme JSON files from
`tugdeck/themes/`. These are already in the correct format. No changes needed.

After removing the `description` field from shipped theme JSON files, run
`bun run generate:tokens` to regenerate. The generation script itself does not
read or use the `description` field, so this is safe.

## Verification Checklist

After implementing these changes, verify:

1. **Create new theme from Brio prototype** — theme saves successfully, appears
   in theme list with the user's display name, can be activated
2. **Create new theme from Harmony prototype** — same verification
3. **Inspect saved JSON** at `~/.tugtool/themes/<name>.json` — should have
   `recipe: "dark"` (not a stringified JSON), `surface`, `text`, `role` at top
   level, and `name` preserving the user's original display name
4. **Activate the saved theme** via Swift menu or POST — correct colors appear,
   no crash
5. **Restart dev server** with the user-authored theme active — correct colors
   from first paint
6. **Edit sliders in generator card** — preview updates instantly, app-wide
   updates after debounce, auto-save writes correct format
7. **Theme list shows the user's name** — "My Cool Theme"
8. **Build succeeds** — `bun run build` exits 0
9. **All tests pass** — `bun test theme-export-import`, `bun test
   theme-middleware`, `bun test vite-config-activate`, `bun test
   gallery-theme-generator-content`
10. **Round-trip test passes** — save → disk → activate works end to end
11. **Legacy file migration** — place a broken-format JSON in
    `~/.tugtool/themes/`, activate it, verify it loads correctly and the file is
    rewritten in canonical format
12. **Negative test** — sending the old broken format (`recipe:
    JSON.stringify(...)`) to save endpoint returns 400

## Files to Change

| File | Change |
|------|--------|
| `tugdeck/src/components/tugways/theme-engine.ts` | Remove `description` field from `ThemeRecipe` interface; remove `@theme-description` from CSS header generation |
| `tugdeck/themes/brio.json` | Remove `description` key |
| `tugdeck/themes/harmony.json` | Remove `description` key |
| `tugdeck/src/components/tugways/cards/gallery-theme-generator-content.tsx` | Fix both save call sites to send `ThemeRecipe` directly; remove `@theme-description` from CSS export header |
| `tugdeck/vite.config.ts` | Replace `ThemeSaveBody` interface; update `handleThemesSave` validation and name handling; add migration guard in `activateThemeOverride` and `themeOverridePlugin`; update `handleThemesList` to read display name from JSON |
| `tugdeck/src/__tests__/theme-export-import.test.tsx` | Update save model test to use correct format |
| `tugdeck/src/__tests__/theme-middleware.test.ts` | Add negative test for old broken format |
| `tugdeck/src/__tests__/vite-config-activate.test.ts` | Add round-trip test (save → activate); add legacy migration test |
| `tugdeck/src/generated/theme-canvas-params.ts` | Regenerated (no `description`); verify gitignored |
