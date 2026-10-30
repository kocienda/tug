# tuggraphics

Tug's graphics language. Layer 0 is a 2D drawing language that is a file format rather than a program: a JSON object whose `ops` are arrays, verb first, positional operands next, an optional options object last. Paint consumes the current path, as in PostScript. Colour is a role (`ink`, `grid`, `series-1`, …) and type is a role (`title`, `label`, `value`, `mono`); neither grammar can name a literal colour or a font.

```json
{"tugdraw": 1, "frame": [560, 240], "ops": [
  ["move", 40, 200], ["line", 520, 200], ["stroke", "grid"],
  ["rect", 60, 120, 32, 80], ["fill", "series-1", {"enter": "grow"}],
  ["text", 76, 216, "Mon", {"anchor": "middle", "baseline": "top"}]
]}
```

- `draw::parse_program` validates a program and reports every error, each with the index of the op that caused it.
- `draw::render_svg` emits the SVG. In deck mode colour roles are classes (`tgf-<role>`, `tgs-<role>`) that the deck's stylesheet resolves to theme tokens, so the output carries no colour value and no `<style>`. In standalone mode one `<style>` resolves the same classes to a given palette.
- `measure` is the contract text layout is measured against: the `Measure` trait, `Metrics`, and `FixedMetrics`, the deterministic measurer the goldens use.
- `chart` is layer 1: a chart spec (`{"tugchart": 1, "form": "bar" | "line" | "sparkline", …}`) validated with every error addressed by JSON pointer, laid out by a closed set of forms into a layer 0 program, and returned with its table alternative and the text Find counts. `compile_with` runs the measure protocol natively against any `Measure`; `compile_round` runs one round against a table measured elsewhere. Every number a chart writes as text goes through `chart::format`.

It is a plain `rlib`, not a WASM crate: `tuggraphics-wasm` is its page shell, and tugcast and tugtool link it natively.

```bash
cd tugdeck/crates
cargo test -p tuggraphics
TUGGRAPHICS_BLESS=1 cargo test -p tuggraphics --test golden   # rewrite the layer 0 goldens after a deliberate change
TUGGRAPHICS_BLESS=1 cargo test -p tuggraphics --test chart    # and the chart goldens
```
