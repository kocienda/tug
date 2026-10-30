//! The `--chart` door: a verb's data as one `TUG-CHART:` stdout line.
//!
//! A `TUG-CHART: ` line carries one layer 1 chart spec, which the Session
//! card's Bash block strips from the terminal text and renders as a figure
//! beneath it, the way a `TUG-FILE-RECEIPT:` line is read for attribution.
//! The spec is built by `tugchart_core`, from what the verb already read, and
//! validated here with the engine itself before it is printed — so a line
//! this module emits is a chart the deck will draw, never one it will refuse.
//!
//! The verbs: `tugtool log --chart` (commits per committer day, a bar),
//! `tugtool test last --chart` (each suite's wall time over its newest runs,
//! a line), `tugtool apptest history --chart` (each file's newest outcomes,
//! dots). `--chart` and the global `--json` are two output shapes for one
//! stdout, so a handler refuses the pair before it reads anything.
//!
//! `tugtool chart <recipe>` and `tugtool chart list` are the catalog's door:
//! `tugchart_core` builds the parser, reads the data and builds the spec, and
//! what is here prints it. A recipe with nothing to draw says so in one line
//! and exits 0.
//!
//! `tugtool chart render` is the standalone door: the same engine with no
//! page under it. Text is measured with the deck's own woff2 faces, embedded
//! here so the binary needs nothing beside it, and the SVG carries one
//! `<style>` resolving its classes to a theme's palette — the colours the
//! page would show, extracted from the themes by
//! `tugdeck/scripts/extract-chart-palette.ts`.

use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::process::ExitCode;

use serde_json::{Value, json};
use tugchart_core::{
    Arg, ArgKind, RECIPES, Recipe, RecipeContext, RecipeOutcome, args_from_matches, catalog_json,
    clap_command, find,
};
use tuggraphics::{CompileOpts, FaceMeasurer, Layers, Palette, TypeRole, compile_with, validate};

use crate::changes::{self, AppError};
use crate::output::print_ok;

/// The deck's faces, the very bytes the page serves.
const SANS_REGULAR: &[u8] =
    include_bytes!("../../../../tugdeck/public/fonts/IBMPlexSans-Regular.woff2");
const SANS_SEMIBOLD: &[u8] =
    include_bytes!("../../../../tugdeck/public/fonts/IBMPlexSans-SemiBold.woff2");
const MONO_REGULAR: &[u8] =
    include_bytes!("../../../../tugdeck/public/fonts/IBMPlexMono-Regular.woff2");

/// `{theme: {role: hex}}`, one resolved colour per chart role per theme.
const PALETTE_JSON: &str = include_str!("../../../../tugdeck/crates/tuggraphics/src/palette.json");

/// Each type role's face, px size and CSS `font` shorthand — the deck's
/// type scale (`--tug-font-size-sm`, `-xs`, `-2xs`) and weights, as
/// `chart-block.css` declares them for the `tgt-<role>` classes.
const ROLE_FACES: [(TypeRole, &[u8], f64, &str); 4] = [
    (
        TypeRole::Title,
        SANS_SEMIBOLD,
        13.0,
        "600 13px \"IBM Plex Sans\"",
    ),
    (
        TypeRole::Label,
        SANS_REGULAR,
        12.0,
        "400 12px \"IBM Plex Sans\"",
    ),
    (
        TypeRole::Value,
        SANS_REGULAR,
        11.0,
        "400 11px \"IBM Plex Sans\"",
    ),
    (
        TypeRole::Mono,
        MONO_REGULAR,
        11.0,
        "400 11px \"IBM Plex Mono\"",
    ),
];

/// The theme names the embedded palette carries, sorted.
pub fn theme_names() -> Vec<String> {
    serde_json::from_str::<Value>(PALETTE_JSON)
        .ok()
        .and_then(|v| v.as_object().map(|o| o.keys().cloned().collect()))
        .unwrap_or_default()
}

/// The palette a standalone SVG's `<style>` resolves to: `theme`'s chart
/// colours from the embedded palette, and the four type roles' fonts.
pub fn palette_for(theme: &str) -> Result<Palette, AppError> {
    let palettes: Value = serde_json::from_str(PALETTE_JSON).map_err(|e| {
        AppError::Exit1(
            "failed",
            format!("the embedded chart palette is not JSON: {e}"),
        )
    })?;
    let Some(colours) = palettes.get(theme).and_then(Value::as_object) else {
        return Err(AppError::Exit1(
            "usage",
            format!(
                "unknown theme {theme:?}; the themes are {}",
                theme_names().join(", ")
            ),
        ));
    };
    let mut palette = Palette::default();
    for (role, hex) in colours {
        let hex = hex.as_str().ok_or_else(|| {
            AppError::Exit1(
                "failed",
                format!("palette colour {theme}/{role} is not a string"),
            )
        })?;
        palette.colours.insert(role.clone(), hex.to_string());
    }
    for (role, _, _, font) in ROLE_FACES {
        palette
            .fonts
            .insert(role.name().to_string(), font.to_string());
    }
    Ok(palette)
}

/// The measurer over the embedded faces, at the deck's sizes.
fn face_measurer() -> Result<FaceMeasurer<'static>, AppError> {
    let faces: Vec<(TypeRole, &[u8], f64)> =
        ROLE_FACES.iter().map(|(r, b, s, _)| (*r, *b, *s)).collect();
    FaceMeasurer::from_woff2(&faces)
        .map_err(|e| AppError::Exit1("failed", format!("cannot read the embedded faces: {e}")))
}

/// Render a chart spec or a drawing, read from `spec` (`-` for stdin), to
/// a standalone SVG at `out`, coloured by `theme`, at most `width` px wide.
/// Prints where it wrote and the figure's size, or the same as a `--json`
/// envelope.
pub fn run_render(
    spec: &str,
    out: &Path,
    theme: &str,
    width: Option<f64>,
    json: bool,
) -> Result<(), AppError> {
    if width.is_some_and(|w| !(w > 0.0 && w.is_finite())) {
        return Err(AppError::Exit1(
            "usage",
            "--width is a positive number of px".to_string(),
        ));
    }
    let source = if spec == "-" {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text).map_err(|e| {
            AppError::Exit1("failed", format!("cannot read the source from stdin: {e}"))
        })?;
        text
    } else {
        std::fs::read_to_string(spec)
            .map_err(|e| AppError::Exit1("failed", format!("cannot read {spec}: {e}")))?
    };
    let palette = palette_for(theme)?;
    let measurer = face_measurer()?;
    let opts = CompileOpts {
        width,
        id_prefix: "tg".to_string(),
        // A file has no stylesheet to play an entrance, so none is written.
        motion: false,
        layers: Layers::Any,
        palette: Some(palette),
        figure_title: true,
    };
    let compiled = compile_with(&source, &opts, &measurer).map_err(|errors| {
        let listed: Vec<String> = errors
            .iter()
            .map(|e| {
                if e.path.is_empty() {
                    e.message.clone()
                } else {
                    format!("{}: {}", e.path, e.message)
                }
            })
            .collect();
        AppError::Exit1(
            "invalid",
            format!("not a valid chart or drawing: {}", listed.join("; ")),
        )
    })?;
    std::fs::write(out, &compiled.svg)
        .map_err(|e| AppError::Exit1("failed", format!("cannot write {}: {e}", out.display())))?;
    if json {
        print_ok(
            "chart render",
            json!({
                "out": out,
                "theme": theme,
                "width": compiled.width,
                "height": compiled.height,
            }),
        );
    } else {
        println!(
            "wrote {} ({}×{} px, theme {theme})",
            out.display(),
            compiled.width,
            compiled.height
        );
    }
    Ok(())
}

/// How `chart list` spells one argument.
fn arg_usage(arg: &Arg) -> String {
    match arg.kind {
        ArgKind::Flag => format!("--{}", arg.flag),
        ArgKind::U32 | ArgKind::Usize => format!("--{} N", arg.flag),
        ArgKind::Str => format!("--{} TEXT", arg.flag),
        ArgKind::StrMany => format!("--{} TEXT...", arg.flag),
        ArgKind::Positional => format!("[{}]", arg.flag),
        ArgKind::PositionalMany => format!("[{}...]", arg.flag),
    }
}

/// `tugtool chart list`: a line per recipe and an indented line of its
/// arguments, or the catalog as a `--json` envelope.
pub fn run_list(json: bool) -> Result<(), AppError> {
    if json {
        print_ok("chart list", catalog_json());
        return Ok(());
    }
    for recipe in &RECIPES {
        println!("{}  {}  {}", recipe.name, recipe.form, recipe.question);
        let args: Vec<String> = recipe.args.iter().map(arg_usage).collect();
        println!("    {}", args.join("  "));
    }
    Ok(())
}

/// `tugtool chart <recipe>`. `argv` is the recipe's name and its arguments,
/// which reached no parser yet, so a `--json` among them is read here beside
/// the global one that came before the name.
pub fn run_recipe(argv: Vec<OsString>, global_json: bool) -> ExitCode {
    let name = argv
        .first()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let Some(recipe) = find(&name) else {
        let unknown = AppError::Exit1(
            "usage",
            format!("unknown recipe {name:?}; `tugtool chart list` lists them"),
        );
        return changes::finish("chart", global_json, Err(unknown));
    };
    let matches = clap_command(recipe)
        .bin_name(format!("tugtool chart {name}"))
        .try_get_matches_from(argv)
        .unwrap_or_else(|err| err.exit());
    let json = global_json || matches.get_flag("json");
    let result = print_recipe(recipe, &matches, json);
    changes::finish(&format!("chart {name}"), json, result)
}

/// Run `recipe` in the current directory's project and print its answer.
fn print_recipe(recipe: &Recipe, matches: &clap::ArgMatches, json: bool) -> Result<(), AppError> {
    let cwd = std::env::current_dir().map_err(|e| {
        AppError::Exit1("failed", format!("cannot read the current directory: {e}"))
    })?;
    let context = RecipeContext::for_project(&cwd);
    let args = args_from_matches(recipe, matches);
    let outcome = recipe
        .run(&context, &args)
        .map_err(|e| AppError::Exit1("failed", e.to_string()))?;
    let (summary, spec) = match outcome {
        RecipeOutcome::Chart { summary, spec } => (summary, Some(spec)),
        RecipeOutcome::NoData { summary } => (summary, None),
    };
    let line = spec.as_ref().map(chart_line).transpose()?;
    if json {
        print_ok(
            &format!("chart {}", recipe.name),
            json!({ "recipe": recipe.name, "summary": summary, "spec": spec }),
        );
    } else {
        println!("{summary}");
        if let Some(line) = line {
            println!("{line}");
        }
    }
    Ok(())
}

/// The head of the stdout line the deck reads.
pub const CHART_LINE_PREFIX: &str = "TUG-CHART: ";

/// Refuse `--chart` beside the global `--json`: both shape the whole of stdout.
pub fn refuse_json(json: bool) -> Result<(), AppError> {
    if json {
        return Err(AppError::Exit1(
            "usage",
            "--chart and --json cannot be combined".to_string(),
        ));
    }
    Ok(())
}

/// The `TUG-CHART: ` line for `spec`, after the engine has accepted it.
/// A spec the engine refuses is a defect in the verb that built it, and is
/// reported as one rather than printed for the deck to refuse later.
pub fn chart_line(spec: &Value) -> Result<String, AppError> {
    let source = serde_json::to_string(spec)
        .map_err(|e| AppError::Exit1("failed", format!("cannot serialize the chart: {e}")))?;
    if let Err(errors) = validate(&source, Layers::Chart) {
        let listed: Vec<String> = errors
            .iter()
            .map(|e| {
                if e.path.is_empty() {
                    e.message.clone()
                } else {
                    format!("{}: {}", e.path, e.message)
                }
            })
            .collect();
        return Err(AppError::Exit1(
            "failed",
            format!(
                "the chart this verb built is not valid: {}",
                listed.join("; ")
            ),
        ));
    }
    Ok(format!("{CHART_LINE_PREFIX}{source}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chart_line_prints_a_valid_spec_after_its_prefix() {
        let line = chart_line(&json!({
            "tugchart": 1,
            "form": "sparkline",
            "values": [1, 2, 3],
        }))
        .unwrap();
        assert!(line.starts_with(CHART_LINE_PREFIX));
    }

    #[test]
    fn chart_line_refuses_an_invalid_spec() {
        let err = chart_line(&json!({ "tugchart": 1, "form": "pie" })).unwrap_err();
        assert!(matches!(err, AppError::Exit1("failed", _)));
    }

    #[test]
    fn refuse_json_names_the_pair() {
        assert!(refuse_json(false).is_ok());
        assert!(matches!(
            refuse_json(true),
            Err(AppError::Exit1("usage", _))
        ));
    }
}
