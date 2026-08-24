# TugFormatter: Value Formatting & Validation

Formatting and validation infrastructure for tugways. Modeled on Apple's Foundation `Formatter` hierarchy — a common interface with type-specific implementations. We build the number formatter now; date, duration, relative time, and other formatters plug in later using the same pattern.

---

## Architecture

### The Formatter Pattern

Every formatter is a bidirectional value transformer: `format(value) → string` and `parse(string) → value`. Apple's `NSFormatter` / `Formatter` hierarchy has been doing this since NeXTSTEP. We follow the same idea.

```
TugFormatter (interface)
  ├── TugNumberFormatter    ← built now
  ├── TugDateFormatter      ← future
  ├── TugDurationFormatter  ← future
  ├── TugRelativeFormatter  ← future (e.g., "3 minutes ago")
  ├── TugByteFormatter      ← future (e.g., "5.4 GB")
  └── ...
```

**Common interface:**

```typescript
interface TugFormatter<T> {
  /** Format a value for display. */
  format(value: T): string;
  /** Parse a display string back to a value. Returns null if unparseable. */
  parse(input: string): T | null;
}
```

Each formatter is a plain object or class instance — not a React component, not a hook. Usable anywhere: in a TugSlider value display, in a TugLabel, in a TugStatCard, in a non-React utility, in a test.

### What We Build Now

1. **TugNumberFormatter** — the first formatter. Covers integers, decimals, percentages, compact notation (1.23M), currency, and custom units.
2. **Numeric validation utilities** — clamp, snap-to-step, coerce, validate pipeline. Used by any component that accepts numeric input.

---

## TugNumberFormatter (`tug-number-formatter.ts`)

Wraps `Intl.NumberFormat`. Zero external dependencies — uses the browser's built-in formatting engine.

### Styles

A number formatter is created with a **style** that determines how values are displayed and parsed:

| Style | Example Input | Example Output | Intl Mode |
|-------|--------------|----------------|-----------|
| `decimal` | `1234.5` | `"1,234.5"` | `style: "decimal"` |
| `integer` | `1234.7` | `"1,235"` | `maximumFractionDigits: 0` |
| `percent` | `0.75` | `"75%"` | `style: "percent"` |
| `compact` | `1230000` | `"1.23M"` | `notation: "compact"` |
| `currency` | `42` | `"$42.00"` | `style: "currency"` |
| `unit` | `2.5` | `"2.5 s"` | `style: "unit"` |
| `custom` | `1234` | `"1,234 pts"` | decimal + suffix |

### API

```typescript
interface TugNumberFormatterOptions {
  /** Formatting style. Default: "decimal". */
  style?: "decimal" | "integer" | "percent" | "compact" | "currency" | "unit" | "custom";

  /** Decimal places. Default: style-dependent (0 for integer, 2 for currency, etc.) */
  decimals?: number;
  /** Minimum decimal places. Overrides decimals for min only. */
  minDecimals?: number;

  /** Currency code (required when style is "currency"). */
  currency?: string;
  /** Unit (required when style is "unit"). Uses Intl unit identifiers: "second", "gigabyte", etc. */
  unit?: string;
  /** Unit display mode. Default: "short". */
  unitDisplay?: "short" | "narrow" | "long";

  /** Custom suffix for "custom" style (e.g., "pts", "x", "dB"). */
  suffix?: string;
  /** Custom prefix for "custom" style. */
  prefix?: string;

  /** Use grouping separators. Default: true. */
  grouping?: boolean;
  /** Locale. Default: "en-US". */
  locale?: string;
}

/** Create a number formatter. */
function createNumberFormatter(options?: TugNumberFormatterOptions): TugFormatter<number>;
```

### Usage Examples

```typescript
// Simple decimal
const decimal = createNumberFormatter();
decimal.format(1234.5)          // "1,234.5"
decimal.parse("1,234.5")        // 1234.5

// Integer (no decimals, rounds)
const int = createNumberFormatter({ style: "integer" });
int.format(1234.7)              // "1,235"
int.parse("1,235")              // 1235

// Percentage (caller works in 0-1 range)
const pct = createNumberFormatter({ style: "percent" });
pct.format(0.75)                // "75%"
pct.parse("75%")                // 0.75

// Compact notation (millions, billions, etc.)
const compact = createNumberFormatter({ style: "compact", decimals: 2 });
compact.format(1230000)         // "1.23M"
compact.format(5400000000)      // "5.4B"
compact.parse("1.23M")          // 1230000

// Currency
const usd = createNumberFormatter({ style: "currency", currency: "USD" });
usd.format(42)                  // "$42.00"
usd.parse("$42.00")             // 42

// Units (uses Intl unit identifiers)
const seconds = createNumberFormatter({ style: "unit", unit: "second", decimals: 1 });
seconds.format(2.5)             // "2.5 s"
seconds.parse("2.5 s")          // 2.5

const bytes = createNumberFormatter({ style: "unit", unit: "gigabyte", decimals: 1 });
bytes.format(5.4)               // "5.4 GB"
bytes.parse("5.4 GB")           // 5.4

// Custom suffix
const points = createNumberFormatter({ style: "custom", suffix: " pts" });
points.format(1234)             // "1,234 pts"
points.parse("1,234 pts")       // 1234

// In a TugLabel — just call format()
<TugLabel>{bytes.format(diskUsage)}</TugLabel>   // "5.4 GB"

// In a TugSlider — pass the formatter
<TugSlider min={0} max={100} formatter={pct} />  // shows "75%" in value input

// In a TugStatCard — format the headline number
<TugStatCard value={compact.format(revenue)} label="Revenue" />  // "1.23M"
```

### Implementation Notes

- `createNumberFormatter` returns a frozen `{ format, parse }` object — cheap to create, safe to share
- Internally creates an `Intl.NumberFormat` instance, cached by serialized options key
- `parse` uses `Intl.NumberFormat.formatToParts()` to detect the locale's group and decimal separators, then strips non-numeric characters and normalizes
- Compact parse ("1.23M" → 1230000) maps suffix letters to multipliers: K=1e3, M=1e6, B=1e9, T=1e12
- Percentage: `format` delegates to `Intl.NumberFormat` with `style: "percent"` (which handles the ×100 internally); `parse` divides by 100

---

## Numeric Validation (`tug-validate.ts`)

Pure functions for numeric input validation. No dependencies. ~30-50 lines.

```typescript
/** Clamp a number to [min, max]. */
function clamp(value: number, min: number, max: number): number;

/** Snap to nearest step increment from base. Handles floating-point epsilon. */
function snapToStep(value: number, step: number, min?: number): number;

/** Parse string to number. Returns null for empty, whitespace, or non-numeric input. */
function coerceNumber(input: string): number | null;

/** Full pipeline: parse → clamp → snap. Returns null if input is not a number. */
function validateNumericInput(
  input: string,
  options: { min: number; max: number; step?: number }
): number | null;
```

**Examples:**

```typescript
clamp(150, 0, 100)                                         // 100
snapToStep(7, 5)                                           // 5
snapToStep(8, 5)                                           // 10
snapToStep(0.37, 0.1)                                      // 0.4
coerceNumber("42")                                         // 42
coerceNumber("abc")                                        // null
validateNumericInput("150", { min: 0, max: 100, step: 5 }) // 100
validateNumericInput("37", { min: 0, max: 100, step: 10 }) // 40
```

**Implementation notes:**
- `snapToStep` uses `Math.round((value - min) / step) * step + min` with epsilon correction for floating-point
- `coerceNumber` uses `Number()` (not `parseFloat`) to reject trailing garbage like `"42abc"`
- `validateNumericInput` is the function components call on blur/Enter

---

## Future: Formatted Editable Inputs

**Not built now.** If we later need live-formatting during typing (cursor management in a currency field), we'll add `react-number-format` (~8 kB, MIT). For now, slider and other numeric inputs accept plain text and validate on blur/Enter.

## Future: Other Formatters

Each follows the same `TugFormatter<T>` interface:

| Formatter | Input Type | Example Output | Likely Engine |
|-----------|-----------|----------------|---------------|
| TugDateFormatter | `Date` | `"Mar 26, 2026"` | `Intl.DateTimeFormat` |
| TugDurationFormatter | `number` (seconds) | `"2h 15m"` | Custom |
| TugRelativeFormatter | `Date` | `"3 minutes ago"` | `Intl.RelativeTimeFormat` |
| TugByteFormatter | `number` (bytes) | `"5.4 GB"` | Custom (powers of 1024) |

These are listed for architecture awareness only. None are built until needed.

**Note on TugByteFormatter vs unit style:** `Intl.NumberFormat` with `unit: "gigabyte"` formats the display correctly ("5.4 GB"), but the caller must pre-divide by 1e9. A dedicated TugByteFormatter would take raw byte counts and auto-select the right unit (KB/MB/GB/TB). This is a convenience on top of the number formatter, not a replacement.

---

## Files

```
tugdeck/src/lib/tug-format.ts              — TugFormatter interface + TugNumberFormatter
tugdeck/src/lib/tug-validate.ts            — clamp, snapToStep, coerceNumber, validateNumericInput
tugdeck/src/__tests__/tug-format.test.ts
tugdeck/src/__tests__/tug-validate.test.ts
```

Both files in `src/lib/` alongside `utils.ts`. General utilities, not component-specific.

## Checkpoints

- `bun run build` exits 0
- `bun run test` exits 0
- All seven styles round-trip: `parse(format(value))` returns the original value (within precision)
- Compact parse handles K, M, B, T suffixes
- Percentage round-trips in 0-1 space
- `validateNumericInput` handles: valid numbers, out-of-range, non-numbers, empty strings, whitespace, step snapping
- Floating-point edge case: `snapToStep(0.1 + 0.2, 0.1)` returns `0.3` not `0.30000000000000004`
- No external dependencies
