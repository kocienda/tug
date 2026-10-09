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

use std::path::PathBuf;

const RESOURCE_ROOT_ENV: &str = "TUGCAST_RESOURCE_ROOT";

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
