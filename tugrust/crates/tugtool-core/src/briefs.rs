//! Where a project's briefs live.
//!
//! The setting lives where every other app-wide preference does, the instance's
//! tugbank under `dev.tugapp.app` / `briefs-path`, and the default lives here and is
//! never written back to the store: an unset key means "the project's `briefs/`".

use std::path::{Path, PathBuf};

/// The tugbank domain the briefs directory is stored under — the app's own,
/// beside `default-project-path`.
pub const BRIEFS_PATH_DOMAIN: &str = "dev.tugapp.app";

/// The tugbank key holding the briefs-directory template.
pub const BRIEFS_PATH_KEY: &str = "briefs-path";

/// The template used when the key is unset. Held in the binary and never
/// written to the store, so an unset key keeps meaning "the project's own".
pub const DEFAULT_BRIEFS_TEMPLATE: &str = "{project_dir}/briefs";

/// The one placeholder a template may carry, spelled like the `{paths}` and
/// `{base}` of the arc surface contract.
const PROJECT_DIR_PLACEHOLDER: &str = "{project_dir}";

/// Resolve a template against a project directory.
///
/// Every `{project_dir}` is replaced; a result that is still relative is
/// joined under the project, so a bare `writing` means the project's own
/// `writing/` and an absolute path means itself — one directory for every
/// project, if that is what the user wants.
pub fn resolve_briefs_dir(project_dir: &Path, template: &str) -> PathBuf {
    let expanded = template.replace(PROJECT_DIR_PLACEHOLDER, &project_dir.to_string_lossy());
    let candidate = PathBuf::from(expanded);
    if candidate.is_absolute() {
        candidate
    } else {
        project_dir.join(candidate)
    }
}
