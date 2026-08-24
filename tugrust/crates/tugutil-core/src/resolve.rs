//! Plan resolution logic
//!
//! This module provides unified plan resolution via a five-stage cascade:
//! 1. Exact path (starts with / or .)
//! 2. Bare filename (starts with tugplan-)
//! 3. Slug (tugplan-{input}.md)
//! 4. Prefix (unique slug starting with input)
//! 5. Auto-select (single plan when input is empty or no prior match)

use std::path::{Path, PathBuf};

use crate::config::{find_tugplans, plan_search_dirs, tugplan_name_from_path};
use crate::error::TugError;

/// Which cascade stage produced the match
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveStage {
    /// Exact path (starts with / or .)
    Exact,
    /// Bare filename (starts with tugplan-)
    Filename,
    /// Slug (tugplan-{input}.md)
    Slug,
    /// Prefix match (unique slug starting with input)
    Prefix,
    /// Auto-select (single plan)
    Auto,
}

/// Result of resolving a plan identifier
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveResult {
    /// Exactly one plan matched, with the stage that matched
    Found { path: PathBuf, stage: ResolveStage },
    /// No plan matched the input
    NotFound,
    /// Multiple plans matched; candidates are sorted
    Ambiguous(Vec<PathBuf>),
}

/// Resolve a user-provided plan identifier to a plan file path.
///
/// Cascade: exact path -> bare filename -> slug -> prefix -> auto-select.
/// Returns Err(TugError) for filesystem/init errors (e.g., missing .tugtool/).
///
/// # Arguments
/// * `input` - User-provided plan identifier (path, filename, slug, or empty for auto-select)
/// * `project_root` - Root directory containing .tugtool/
///
/// # Returns
/// * `Ok(ResolveResult::Found { path, stage })` - Single match found
/// * `Ok(ResolveResult::NotFound)` - No matches
/// * `Ok(ResolveResult::Ambiguous(candidates))` - Multiple matches
/// * `Err(TugError)` - Filesystem or initialization error
pub fn resolve_plan(input: &str, project_root: &Path) -> Result<ResolveResult, TugError> {
    let input = input.trim();

    // Stage 1: Exact path (starts with / or .)
    if input.starts_with('/') || input.starts_with('.') {
        let path = Path::new(input);
        if path.exists() {
            return Ok(ResolveResult::Found {
                path: path.to_path_buf(),
                stage: ResolveStage::Exact,
            });
        } else {
            return Ok(ResolveResult::NotFound);
        }
    }

    // Where this project keeps plans: `.tugtool/` plus whatever it declared.
    let search_dirs = plan_search_dirs(project_root);

    // Stage 2: Bare filename (starts with tugplan-)
    if input.starts_with("tugplan-") {
        let filename = if input.ends_with(".md") {
            input.to_string()
        } else {
            format!("{}.md", input)
        };
        for search_dir in &search_dirs {
            let path = project_root.join(search_dir).join(&filename);
            if path.exists() {
                return Ok(ResolveResult::Found {
                    path,
                    stage: ResolveStage::Filename,
                });
            }
        }
        return Ok(ResolveResult::NotFound);
    }

    // Stage 3: Slug (tugplan-{input}.md)
    if !input.is_empty() {
        let filename = format!("tugplan-{}.md", input);
        for search_dir in &search_dirs {
            let path = project_root.join(search_dir).join(&filename);
            if path.exists() {
                return Ok(ResolveResult::Found {
                    path,
                    stage: ResolveStage::Slug,
                });
            }
        }
    }

    // Stage 4: Prefix (unique slug starting with input)
    // Stage 5: Auto-select (single plan when input is empty or no prior match)
    // Both stages require enumeration, so we call find_tugplans once
    let tugplans = find_tugplans(project_root)?;

    if !input.is_empty() {
        // Stage 4: Prefix matching
        let mut matches: Vec<PathBuf> = tugplans
            .iter()
            .filter(|path| {
                if let Some(slug) = tugplan_name_from_path(path) {
                    slug.starts_with(input)
                } else {
                    false
                }
            })
            .cloned()
            .collect();

        if matches.len() == 1 {
            return Ok(ResolveResult::Found {
                path: matches.remove(0),
                stage: ResolveStage::Prefix,
            });
        } else if matches.len() > 1 {
            matches.sort();
            return Ok(ResolveResult::Ambiguous(matches));
        }
        // Fall through to Stage 5 if no prefix matches
    }

    // Stage 5: Auto-select (exactly one plan exists)
    if tugplans.len() == 1 {
        Ok(ResolveResult::Found {
            path: tugplans[0].clone(),
            stage: ResolveStage::Auto,
        })
    } else if tugplans.len() > 1 {
        let mut sorted = tugplans.clone();
        sorted.sort();
        Ok(ResolveResult::Ambiguous(sorted))
    } else {
        Ok(ResolveResult::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Helper: create a test project with .tugtool/ and specified plan files
    fn setup_project(plans: &[&str]) -> TempDir {
        let tmp = TempDir::new().unwrap();
        let tugtool_dir = tmp.path().join(".tugtool");
        fs::create_dir(&tugtool_dir).unwrap();

        for plan in plans {
            let filename = if plan.starts_with("tugplan-") {
                plan.to_string()
            } else {
                format!("tugplan-{}.md", plan)
            };
            let path = tugtool_dir.join(&filename);
            fs::write(&path, "# Test Plan\n").unwrap();
        }

        tmp
    }

    /// The name these tests use for a declared paperwork directory. It is
    /// deliberately not `roadmap` — nothing in the search is keyed to a
    /// particular word any more.
    const DOCS: &str = "paperwork";

    /// Helper: declare a paperwork directory and write plan files into it.
    fn add_docs_plans(tmp: &TempDir, plans: &[&str]) {
        fs::write(
            tmp.path().join(".tugtool").join("config.toml"),
            format!("[tugtool.dash]\ndocs = \"{DOCS}\"\n"),
        )
        .unwrap();

        let docs_dir = tmp.path().join(DOCS);
        if !docs_dir.exists() {
            fs::create_dir(&docs_dir).unwrap();
        }
        for plan in plans {
            let filename = if plan.starts_with("tugplan-") {
                plan.to_string()
            } else {
                format!("tugplan-{}.md", plan)
            };
            let path = docs_dir.join(&filename);
            fs::write(&path, "# Paperwork Plan\n").unwrap();
        }
    }

    #[test]
    fn test_exact_path() {
        let tmp = setup_project(&["1"]);
        let plan_path = tmp.path().join(".tugtool/tugplan-1.md");

        // Use the full path (which exists) to test exact path matching
        let path_str = plan_path.to_str().unwrap();
        let result = resolve_plan(path_str, tmp.path()).unwrap();

        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Exact);
                assert_eq!(path, plan_path);
            }
            _ => panic!("Expected Found with Exact stage"),
        }
    }

    #[test]
    fn test_exact_path_not_found() {
        let tmp = setup_project(&["1"]);
        let result = resolve_plan("./nonexistent.md", tmp.path()).unwrap();
        assert_eq!(result, ResolveResult::NotFound);
    }

    #[test]
    fn test_bare_filename() {
        let tmp = setup_project(&["user-auth"]);
        let result = resolve_plan("tugplan-user-auth.md", tmp.path()).unwrap();

        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Filename);
                assert!(path.ends_with("tugplan-user-auth.md"));
            }
            _ => panic!("Expected Found with Filename stage"),
        }
    }

    #[test]
    fn test_bare_filename_without_extension() {
        let tmp = setup_project(&["user-auth"]);
        let result = resolve_plan("tugplan-user-auth", tmp.path()).unwrap();

        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Filename);
                assert!(path.ends_with("tugplan-user-auth.md"));
            }
            _ => panic!("Expected Found with Filename stage"),
        }
    }

    #[test]
    fn test_slug_descriptive() {
        let tmp = setup_project(&["user-auth"]);
        let result = resolve_plan("user-auth", tmp.path()).unwrap();

        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Slug);
                assert!(path.ends_with("tugplan-user-auth.md"));
            }
            _ => panic!("Expected Found with Slug stage"),
        }
    }

    #[test]
    fn test_slug_numeric() {
        let tmp = setup_project(&["1"]);
        let result = resolve_plan("1", tmp.path()).unwrap();

        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Slug);
                assert!(path.ends_with("tugplan-1.md"));
            }
            _ => panic!("Expected Found with Slug stage"),
        }
    }

    #[test]
    fn test_unique_prefix() {
        let tmp = setup_project(&["user-auth"]);
        let result = resolve_plan("user", tmp.path()).unwrap();

        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Prefix);
                assert!(path.ends_with("tugplan-user-auth.md"));
            }
            _ => panic!("Expected Found with Prefix stage"),
        }
    }

    #[test]
    fn test_ambiguous_prefix() {
        let tmp = setup_project(&["user-auth", "user-roles"]);
        let result = resolve_plan("user", tmp.path()).unwrap();

        match result {
            ResolveResult::Ambiguous(candidates) => {
                assert_eq!(candidates.len(), 2);
                // Verify sorted order
                assert!(candidates[0].ends_with("tugplan-user-auth.md"));
                assert!(candidates[1].ends_with("tugplan-user-roles.md"));
            }
            _ => panic!("Expected Ambiguous result"),
        }
    }

    #[test]
    fn test_auto_select_single() {
        let tmp = setup_project(&["only-plan"]);
        let result = resolve_plan("", tmp.path()).unwrap();

        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Auto);
                assert!(path.ends_with("tugplan-only-plan.md"));
            }
            _ => panic!("Expected Found with Auto stage"),
        }
    }

    #[test]
    fn test_auto_select_multiple() {
        let tmp = setup_project(&["plan-1", "plan-2"]);
        let result = resolve_plan("", tmp.path()).unwrap();

        match result {
            ResolveResult::Ambiguous(candidates) => {
                assert_eq!(candidates.len(), 2);
            }
            _ => panic!("Expected Ambiguous result"),
        }
    }

    #[test]
    fn test_not_found() {
        let tmp = setup_project(&[]);
        let result = resolve_plan("nonexistent", tmp.path()).unwrap();
        assert_eq!(result, ResolveResult::NotFound);
    }

    #[test]
    fn test_empty_input_no_plans() {
        let tmp = setup_project(&[]);
        let result = resolve_plan("", tmp.path()).unwrap();
        assert_eq!(result, ResolveResult::NotFound);
    }

    #[test]
    fn test_missing_tugtool_dir_for_prefix() {
        let tmp = TempDir::new().unwrap();
        // Don't create .tugtool/ dir
        let result = resolve_plan("foo", tmp.path());

        match result {
            Err(TugError::NotInitialized) => {
                // Expected: find_tugplans() fails because .tugtool/ doesn't exist
            }
            _ => panic!("Expected NotInitialized error"),
        }
    }

    #[test]
    fn test_exact_path_without_tugtool() {
        let tmp = TempDir::new().unwrap();
        // Don't create .tugtool/ dir
        // Create a file directly
        let file_path = tmp.path().join("test.md");
        fs::write(&file_path, "# Test\n").unwrap();

        // Use absolute path (which starts with /)
        let path_str = file_path.to_str().unwrap();
        let result = resolve_plan(path_str, tmp.path()).unwrap();

        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Exact);
                assert_eq!(path, file_path);
            }
            _ => panic!("Expected Found with Exact stage"),
        }
    }

    #[test]
    fn test_non_empty_input_falls_through_to_auto_select() {
        let tmp = setup_project(&["only-plan"]);
        // Input "nonexistent" doesn't match any stage 1-4, falls through to stage 5
        let result = resolve_plan("nonexistent", tmp.path()).unwrap();

        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Auto);
                assert!(path.ends_with("tugplan-only-plan.md"));
            }
            _ => panic!("Expected Found with Auto stage"),
        }
    }

    #[test]
    fn test_slug_resolves_from_declared_docs_dir() {
        let tmp = setup_project(&[]);
        add_docs_plans(&tmp, &["dev"]);

        let result = resolve_plan("dev", tmp.path()).unwrap();
        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Slug);
                assert!(path.ends_with(format!("{DOCS}/tugplan-dev.md")));
            }
            _ => panic!("Expected Found with Slug stage from the declared docs dir"),
        }
    }

    /// The old hardcoded `roadmap` entry is gone: an undeclared project is
    /// searched in `.tugtool/` alone, whatever it happens to have lying around.
    #[test]
    fn test_undeclared_project_does_not_search_roadmap() {
        let tmp = setup_project(&[]);
        let roadmap = tmp.path().join("roadmap");
        fs::create_dir(&roadmap).unwrap();
        fs::write(roadmap.join("tugplan-dev.md"), "# Not searched\n").unwrap();

        assert_eq!(
            resolve_plan("dev", tmp.path()).unwrap(),
            ResolveResult::NotFound
        );
        assert_eq!(
            resolve_plan("tugplan-dev", tmp.path()).unwrap(),
            ResolveResult::NotFound
        );
        assert!(find_tugplans(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn test_bare_filename_resolves_from_declared_docs_dir() {
        let tmp = setup_project(&[]);
        add_docs_plans(&tmp, &["dev"]);

        let result = resolve_plan("tugplan-dev", tmp.path()).unwrap();
        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Filename);
                assert!(path.ends_with(format!("{DOCS}/tugplan-dev.md")));
            }
            _ => panic!("Expected Found with Filename stage from the declared docs dir"),
        }
    }

    #[test]
    fn test_tugtool_wins_over_docs_dir_for_same_slug() {
        let tmp = setup_project(&["shared"]);
        add_docs_plans(&tmp, &["shared"]);

        let result = resolve_plan("shared", tmp.path()).unwrap();
        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Slug);
                // .tugtool/ is searched first, so it wins
                assert!(path.to_string_lossy().contains(".tugtool"));
                assert!(!path.to_string_lossy().contains(DOCS));
            }
            _ => panic!("Expected Found preferring .tugtool/"),
        }
    }

    #[test]
    fn test_prefix_match_across_dirs() {
        let tmp = setup_project(&["active-work"]);
        add_docs_plans(&tmp, &["future-idea"]);

        let result = resolve_plan("active", tmp.path()).unwrap();
        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Prefix);
                assert!(path.ends_with("tugplan-active-work.md"));
            }
            _ => panic!("Expected Found with Prefix from .tugtool/"),
        }

        let result = resolve_plan("future", tmp.path()).unwrap();
        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Prefix);
                assert!(path.ends_with("tugplan-future-idea.md"));
            }
            _ => panic!("Expected Found with Prefix from the declared docs dir"),
        }
    }

    #[test]
    fn test_ambiguous_across_dirs() {
        let tmp = setup_project(&["user-auth"]);
        add_docs_plans(&tmp, &["user-roles"]);

        let result = resolve_plan("user", tmp.path()).unwrap();
        match result {
            ResolveResult::Ambiguous(candidates) => {
                assert_eq!(candidates.len(), 2);
                // Sorted by full path: .tugtool/... < paperwork/...
                assert!(candidates[0].ends_with(".tugtool/tugplan-user-auth.md"));
                assert!(candidates[1].ends_with(format!("{DOCS}/tugplan-user-roles.md")));
            }
            _ => panic!("Expected Ambiguous across dirs"),
        }
    }

    #[test]
    fn test_auto_select_picks_only_docs_dir_plan() {
        let tmp = setup_project(&[]);
        add_docs_plans(&tmp, &["lonely"]);

        let result = resolve_plan("", tmp.path()).unwrap();
        match result {
            ResolveResult::Found { path, stage } => {
                assert_eq!(stage, ResolveStage::Auto);
                assert!(path.ends_with(format!("{DOCS}/tugplan-lonely.md")));
            }
            _ => panic!("Expected Found with Auto stage from the declared docs dir"),
        }
    }

    #[test]
    fn test_declared_but_absent_docs_dir_is_ok() {
        // The project declares a paperwork home it has not created yet;
        // resolution still works out of .tugtool/.
        let tmp = setup_project(&["only-plan"]);
        fs::write(
            tmp.path().join(".tugtool").join("config.toml"),
            format!("[tugtool.dash]\ndocs = \"{DOCS}\"\n"),
        )
        .unwrap();

        let result = resolve_plan("only-plan", tmp.path()).unwrap();
        match result {
            ResolveResult::Found { stage, .. } => assert_eq!(stage, ResolveStage::Slug),
            _ => panic!("Expected Found with Slug stage when the docs dir is absent"),
        }
    }
}
