//! Resolves the filesystem path under which tugcast expects to find its
//! bundled resources (primarily `tugdeck/dist/`).
//!
//! Primary path: read `TUGCAST_RESOURCE_ROOT` from the process environment.
//! Tug.app sets this at spawn time to `Bundle.main.resourcePath`, which in
//! both Debug and Release builds points at `Tug.app/Contents/Resources/`.
//! This is the single resolution path — debug `just app` and release
//! launches exercise identical code.
//!
//! Fallback (debug builds only): when the env var is unset *or empty*,
//! walk up three parents from `CARGO_MANIFEST_DIR` to reach the tugtool
//! workspace root. This lets standalone `cargo run -p tugcast` and
//! `cargo nextest run` keep working without any bundle wiring. Empty is
//! treated as unset as defense-in-depth: if a misconfigured Swift caller
//! ever set `TUGCAST_RESOURCE_ROOT=""`, `var_os` would return `Some("")`
//! and we'd silently produce a relative path that 404s in ServeDir.
//!
//! Fallback (release builds): panic. A release tugcast that isn't spawned
//! from a Tug.app bundle is a configuration bug; failing loud at startup
//! is strictly better than silently serving 404s or leaking a dev machine
//! path baked into the release binary.

use std::path::{Path, PathBuf};

const RESOURCE_ROOT_ENV: &str = "TUGCAST_RESOURCE_ROOT";

/// Overrides where the bundled help documents are read from — a dev launch
/// pointing at a checkout, or a test pointing at a scratch directory.
pub(crate) const DOCS_DIR_ENV: &str = "TUG_DOCS_DIR";

pub(crate) fn source_tree() -> PathBuf {
    // Treat both "unset" and "set to empty" as unset. `var_os` returns
    // `Some(OsString::from(""))` for an env var set to the empty string,
    // which would otherwise bypass the fallback and return a relative
    // path. See the module-level doc for context.
    if let Some(from_env) = std::env::var_os(RESOURCE_ROOT_ENV) {
        if !from_env.is_empty() {
            return PathBuf::from(from_env);
        }
    }

    #[cfg(debug_assertions)]
    {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent() // crates/
            .and_then(|p| p.parent()) // tugrust/
            .and_then(|p| p.parent()) // tugtool root
            .expect("CARGO_MANIFEST_DIR has at least three ancestors")
            .to_path_buf()
    }

    #[cfg(not(debug_assertions))]
    panic!(
        "{} must be set when tugcast is spawned from a Tug.app bundle. \
         This is a Tug.app configuration bug.",
        RESOURCE_ROOT_ENV
    );
}

/// The directory holding the app's help documents (`features.md` and
/// `glossary.md`), which the app bundle ships at `Contents/Resources/docs/`.
///
/// One resolver for every reader — the help card's route and the Overview's
/// Operator — so the two can never read different files. `None` when no
/// candidate exists, which a reader reports as help being unavailable rather
/// than a panic: a tugcast without its docs still serves everything else.
pub(crate) fn docs_dir() -> Option<PathBuf> {
    resolve_docs_dir(
        non_empty_env(DOCS_DIR_ENV),
        non_empty_env(RESOURCE_ROOT_ENV),
        std::env::current_exe().ok().as_deref(),
        checkout_docs(),
    )
}

/// The resolution order, pure so it can be tested without the process
/// environment: the `TUG_DOCS_DIR` override, then `docs/` under the resource
/// root the app hands a spawned tugcast, then `Contents/Resources/docs`
/// beside the binary (a terminal `tugcast operator-ask` run from inside the
/// bundle sets no resource root), then the checkout's `docs/` on a debug
/// build. The two named directories are taken as given; the two discovered
/// ones count only when they exist.
fn resolve_docs_dir(
    override_dir: Option<PathBuf>,
    resource_root: Option<PathBuf>,
    exe: Option<&Path>,
    checkout: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(dir) = override_dir {
        return Some(dir);
    }
    if let Some(root) = resource_root {
        return Some(root.join("docs"));
    }
    let beside = exe
        .and_then(Path::parent) // MacOS/
        .and_then(Path::parent) // Contents/
        .map(|contents| contents.join("Resources").join("docs"));
    if let Some(dir) = beside.filter(|dir| dir.is_dir()) {
        return Some(dir);
    }
    checkout.filter(|dir| dir.is_dir())
}

/// An environment variable's value, with set-but-empty read as unset for
/// the reason `source_tree` gives.
fn non_empty_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The checkout's `docs/`, for a debug tugcast run with `cargo run` or under
/// nextest. A release binary has no checkout to fall back to.
pub(crate) fn checkout_docs() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .map(|root| root.join("docs"))
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    // Serializes tests that mutate the process-global `TUGCAST_RESOURCE_ROOT`
    // env var. `cargo test` runs tests in parallel by default, so without a
    // guard two tests racing on set/remove would observe each other's state.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn test_source_tree_uses_env_var_when_set() {
        let _guard = ENV_MUTEX.lock();
        // SAFETY: set_var/remove_var are unsafe on newer Rust editions in
        // multi-threaded contexts. ENV_MUTEX serializes access within this
        // test module, and Step 2's callsite tests will use the same lock.
        unsafe {
            std::env::set_var(RESOURCE_ROOT_ENV, "/tmp/tugcast-test-resource-root");
        }
        let result = source_tree();
        unsafe {
            std::env::remove_var(RESOURCE_ROOT_ENV);
        }
        assert_eq!(result, PathBuf::from("/tmp/tugcast-test-resource-root"));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn test_source_tree_fallback_points_at_tugtool_root() {
        let _guard = ENV_MUTEX.lock();
        unsafe {
            std::env::remove_var(RESOURCE_ROOT_ENV);
        }
        let result = source_tree();
        // Sentinel: the tugtool root contains `tugrust/Cargo.toml` (the
        // Cargo workspace manifest). We verify the three-parent walk from
        // `tugcast/src` landed there and not at some unrelated ancestor.
        assert!(
            result.join("tugrust").join("Cargo.toml").exists(),
            "fallback path {} should contain tugrust/Cargo.toml (the tugtool workspace root)",
            result.display(),
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn test_source_tree_fallback_is_absolute() {
        let _guard = ENV_MUTEX.lock();
        unsafe {
            std::env::remove_var(RESOURCE_ROOT_ENV);
        }
        let result = source_tree();
        assert!(
            result.is_absolute(),
            "fallback path {} should be absolute",
            result.display(),
        );
    }

    #[test]
    fn docs_dir_override_wins_over_everything() {
        let found = resolve_docs_dir(
            Some(PathBuf::from("/tmp/override-docs")),
            Some(PathBuf::from("/tmp/resource-root")),
            None,
            None,
        );
        assert_eq!(found, Some(PathBuf::from("/tmp/override-docs")));
    }

    #[test]
    fn docs_dir_sits_under_the_resource_root() {
        let found = resolve_docs_dir(None, Some(PathBuf::from("/tmp/Resources")), None, None);
        assert_eq!(found, Some(PathBuf::from("/tmp/Resources/docs")));
    }

    #[test]
    fn docs_dir_found_beside_a_bundled_binary() {
        let bundle = tempfile::tempdir().unwrap();
        let contents = bundle.path().join("Tug.app").join("Contents");
        let docs = contents.join("Resources").join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::create_dir_all(contents.join("MacOS")).unwrap();
        let exe = contents.join("MacOS").join("tugcast");

        let found = resolve_docs_dir(None, None, Some(&exe), None);
        assert_eq!(found, Some(docs));
    }

    #[test]
    fn docs_dir_skips_a_missing_bundle_dir_for_the_checkout() {
        let scratch = tempfile::tempdir().unwrap();
        let exe = scratch.path().join("target").join("debug").join("tugcast");
        let checkout = scratch.path().join("docs");
        std::fs::create_dir_all(&checkout).unwrap();

        let found = resolve_docs_dir(None, None, Some(&exe), Some(checkout.clone()));
        assert_eq!(found, Some(checkout));
    }

    #[test]
    fn docs_dir_is_none_when_nothing_exists() {
        let scratch = tempfile::tempdir().unwrap();
        let exe = scratch.path().join("MacOS").join("tugcast");
        let found = resolve_docs_dir(None, None, Some(&exe), Some(scratch.path().join("docs")));
        assert_eq!(found, None);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn checkout_docs_holds_both_help_documents() {
        let docs = checkout_docs().expect("debug build has a checkout");
        assert!(docs.join("features.md").is_file(), "{}", docs.display());
        assert!(docs.join("glossary.md").is_file(), "{}", docs.display());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn test_source_tree_treats_empty_env_var_as_unset() {
        let _guard = ENV_MUTEX.lock();
        // Set to empty string — simulates a Swift caller that fumbled a nil
        // Bundle.main.resourcePath. Without the defense-in-depth check,
        // var_os would return Some("") and source_tree() would return
        // PathBuf::from(""). The fix: treat empty as unset and take the
        // debug fallback, yielding the tugtool workspace root.
        unsafe {
            std::env::set_var(RESOURCE_ROOT_ENV, "");
        }
        let result = source_tree();
        unsafe {
            std::env::remove_var(RESOURCE_ROOT_ENV);
        }
        assert!(
            result.join("tugrust").join("Cargo.toml").exists(),
            "empty env var should fall back to tugtool root; got {}",
            result.display(),
        );
    }
}
