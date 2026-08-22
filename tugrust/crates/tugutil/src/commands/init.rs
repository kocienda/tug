//! Implementation of the `tugutil init` command

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use crate::output::{InitCheckData, InitData, JsonResponse};

/// Default config.toml content
const DEFAULT_CONFIG: &str = r#"[tugtool.dash]
# Commands run from a new dash worktree to hydrate it (deps, etc.).
# A git worktree never inherits gitignored files, so these install what a
# fresh checkout lacks. A non-zero exit rolls the worktree back.
post_create = []
# post_create = ["npm install"]

# The run-ending's fit check, run from the worktree root once the replay has
# put the rounds on the live base. {base} and {head} are replaced with that
# range; a command carrying neither runs unscoped. Declare none and the ending
# falls back to the plan's own checkpoint commands.
# verify = "sh scripts/check.sh {base} {head}"

# The command that produces an inspectable instance from this worktree.
# Declare none and no build is offered.
# build = "make app"
"#;

/// Check if the project is initialized
///
/// # Arguments
/// * `root` - Optional root directory (uses current directory if None)
/// * `json_output` - Output in JSON format
pub fn run_init_check(root: Option<&Path>, json_output: bool) -> Result<i32, String> {
    let base = root.unwrap_or_else(|| Path::new("."));
    let config_path = base.join(".tugtool/config.toml");
    let initialized = config_path.exists();

    if json_output {
        let response = JsonResponse::ok(
            "init",
            InitCheckData {
                initialized,
                path: ".tugtool/".to_string(),
            },
        );
        println!("{}", serde_json::to_string_pretty(&response).unwrap());
    }

    // Return exit code 0 if initialized, 9 (E009) if not
    if initialized { Ok(0) } else { Ok(9) }
}

/// Run the init command
pub fn run_init(force: bool, check: bool, json_output: bool, quiet: bool) -> Result<i32, String> {
    // Route to check if --check flag is set
    if check {
        return run_init_check(None, json_output);
    }
    let tug_dir = Path::new(".tugtool");

    // When .tugtool/ exists and --force is not set, create only missing files (idempotent).
    // When --force is set, remove and recreate everything.
    if tug_dir.exists() && !force {
        // Idempotent mode: create only missing files
        let mut files_created = vec![];

        let config_path = tug_dir.join("config.toml");
        if !config_path.exists() {
            fs::write(&config_path, DEFAULT_CONFIG)
                .map_err(|e| format!("failed to write config.toml: {}", e))?;
            files_created.push("config.toml".to_string());
        }

        // Handle .gitignore even in idempotent mode
        ensure_gitignore(quiet)?;

        if json_output {
            let response = JsonResponse::ok(
                "init",
                InitData {
                    path: ".tugtool/".to_string(),
                    files_created: files_created.clone(),
                },
            );
            println!("{}", serde_json::to_string_pretty(&response).unwrap());
        } else if !quiet {
            if files_created.is_empty() {
                println!("Tug project already initialized in .tugtool/ (nothing to do)");
            } else {
                println!("Tug project in .tugtool/ updated:");
                for f in &files_created {
                    if f.starts_with("removed ") || f.starts_with("cleaned ") {
                        println!("  {}", f);
                    } else {
                        println!("  Created: {}", f);
                    }
                }
            }
        }

        return Ok(0);
    }

    // Force mode: remove and recreate everything
    if force && tug_dir.exists() {
        fs::remove_dir_all(tug_dir)
            .map_err(|e| format!("failed to remove existing .tugtool directory: {}", e))?;
    }

    fs::create_dir_all(tug_dir)
        .map_err(|e| format!("failed to create .tugtool directory: {}", e))?;

    // Create config.toml
    let config_path = tug_dir.join("config.toml");
    fs::write(&config_path, DEFAULT_CONFIG)
        .map_err(|e| format!("failed to write config.toml: {}", e))?;

    ensure_gitignore(quiet)?;

    let files_created = vec!["config.toml".to_string()];

    if json_output {
        let response = JsonResponse::ok(
            "init",
            InitData {
                path: ".tugtool/".to_string(),
                files_created,
            },
        );
        println!("{}", serde_json::to_string_pretty(&response).unwrap());
    } else if !quiet {
        println!("Initialized tugutil project in .tugtool/");
        println!("  Created: config.toml");
    }

    Ok(0)
}

/// Ensure `.tug/` is listed in .gitignore ([P13]).
///
/// `.tug/` covers the new worktree home (`.tug/worktrees/`). Any pre-existing
/// `.tugtree/` line is left in place so a project mid-migration keeps its legacy
/// worktrees ignored until they move.
fn ensure_gitignore(_quiet: bool) -> Result<(), String> {
    let gitignore_path = Path::new(".gitignore");
    let gitignore_entry = ".tug/";

    let should_add_entry = if gitignore_path.exists() {
        let content = fs::read_to_string(gitignore_path)
            .map_err(|e| format!("failed to read .gitignore: {}", e))?;
        !content.lines().any(|line| line.trim() == gitignore_entry)
    } else {
        true
    };

    if should_add_entry {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(gitignore_path)
            .map_err(|e| format!("failed to open .gitignore: {}", e))?;

        if gitignore_path.exists() {
            let content = fs::read_to_string(gitignore_path).unwrap_or_default();
            if !content.is_empty() && !content.ends_with('\n') {
                writeln!(file).map_err(|e| format!("failed to write to .gitignore: {}", e))?;
            }
        }

        writeln!(
            file,
            "\n# Tug worktrees (isolated implementation environments)"
        )
        .map_err(|e| format!("failed to write to .gitignore: {}", e))?;
        writeln!(file, "{}", gitignore_entry)
            .map_err(|e| format!("failed to write to .gitignore: {}", e))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_init_check_not_initialized() {
        let temp = TempDir::new().expect("failed to create temp dir");
        let temp_path = temp.path();

        // No .tugtool directory - should return exit code 9
        let result = run_init_check(Some(temp_path), false).expect("init check should not error");
        assert_eq!(result, 9, "should return exit code 9 for not initialized");
        // TempDir auto-cleans on drop - no manual cleanup needed
    }

    #[test]
    fn test_init_check_initialized() {
        let temp = TempDir::new().expect("failed to create temp dir");
        let temp_path = temp.path();

        // Create .tugtool directory with config
        let tug_dir = temp_path.join(".tugtool");
        fs::create_dir_all(&tug_dir).expect("failed to create .tugtool");
        fs::write(tug_dir.join("config.toml"), "test content").expect("failed to write config");

        let result = run_init_check(Some(temp_path), false).expect("init check should not error");
        assert_eq!(result, 0, "should return exit code 0 for initialized");
        // TempDir auto-cleans on drop - no manual cleanup needed
    }

    #[test]
    fn test_init_check_json_output() {
        let temp = TempDir::new().expect("failed to create temp dir");
        let temp_path = temp.path();

        // Capture stdout would require more infrastructure, so we just verify it doesn't error
        let result = run_init_check(Some(temp_path), true).expect("init check should not error");
        assert_eq!(result, 9, "should return exit code 9");
        // TempDir auto-cleans on drop - no manual cleanup needed
    }
}
