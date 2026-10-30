//! Byte-for-byte goldens: every `tests/golden/<name>.json` program renders
//! in deck mode to exactly `tests/golden/<name>.svg`.
//!
//! After a deliberate change to the output, rewrite them with
//! `TUGGRAPHICS_BLESS=1 cargo test -p tuggraphics --test golden` and read
//! the diff before committing it.

use std::fs;
use std::path::Path;

use tuggraphics::{render_program, RenderOpts};

#[test]
fn layer0_goldens() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let bless = std::env::var_os("TUGGRAPHICS_BLESS").is_some();
    let mut names: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| {
            let p = e.unwrap().path();
            (p.extension()? == "json")
                .then(|| p.file_stem().unwrap().to_string_lossy().into_owned())
        })
        .collect();
    names.sort();
    assert!(
        names.len() >= 6,
        "expected the layer 0 goldens, found {names:?}"
    );
    let mut failed = Vec::new();
    for name in &names {
        let source = fs::read_to_string(dir.join(format!("{name}.json"))).unwrap();
        let svg = render_program(
            &source,
            &RenderOpts {
                id_prefix: "g",
                standalone: None,
            },
        )
        .unwrap_or_else(|e| panic!("{name}.json does not validate: {e:?}"));
        let golden = dir.join(format!("{name}.svg"));
        if bless {
            fs::write(&golden, &svg).unwrap();
        } else if fs::read_to_string(&golden).ok().as_deref() != Some(svg.as_str()) {
            failed.push(format!("{name}:\n{svg}"));
        }
    }
    assert!(
        failed.is_empty(),
        "goldens differ:\n{}",
        failed.join("\n\n")
    );
}
