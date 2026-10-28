//! The lab project: a fresh repository under `/tmp/arc-lab/<run-id>/repo`,
//! one per run and never reused, with the scenario's files on `main` and a
//! `.tugtool/config.toml` declaring the surfaces the scenario names.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::scenario::Surface;

/// A built lab project.
pub struct LabProject {
    pub root: PathBuf,
}

/// The run's directory, under the one lab root.
pub fn run_dir(run_id: &str) -> PathBuf {
    PathBuf::from("/tmp/arc-lab").join(run_id)
}

/// `git -C root <args>`, through tugcore's door so the lab's git carries the
/// same settings the product's does; an identity is written into the
/// repository's own config so a machine with none still commits.
pub fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = tugcore::git_command()
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("spawning git {args:?}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {args:?} in {} failed ({}): {}",
            root.display(),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// What the lab project's `.tugtool/config.toml` says.
pub fn config_toml(surfaces: &[Surface]) -> String {
    let mut out = String::from(
        "# Written by the arc crossing lab for one run. The surfaces are the\n\
         # scenario's; an exam runs their checks against a join candidate.\n\
         [tugtool.arc]\n",
    );
    for surface in surfaces {
        out.push_str("\n[[tugtool.arc.surface]]\n");
        out.push_str(&format!("name = {}\n", toml_str(surface.name)));
        out.push_str(&format!("paths = [{}]\n", toml_list(surface.paths)));
        out.push_str(&format!("check = [{}]\n", toml_list(surface.check)));
    }
    out
}

fn toml_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn toml_list(items: &[&str]) -> String {
    items
        .iter()
        .map(|s| toml_str(s))
        .collect::<Vec<_>>()
        .join(", ")
}

impl LabProject {
    /// Make the repository at `dir/repo`: `main`, the files, the config, one
    /// commit. `dir` must not already hold a repository — a run is never
    /// reused.
    pub fn build(
        dir: &Path,
        files: &[(&str, String)],
        surfaces: &[Surface],
    ) -> Result<Self, String> {
        let root = dir.join("repo");
        if root.exists() {
            return Err(format!(
                "{} exists; a run directory is never reused",
                root.display()
            ));
        }
        std::fs::create_dir_all(&root).map_err(|e| format!("creating {}: {e}", root.display()))?;
        git(&root, &["init", "-q", "-b", "main"])?;
        git(&root, &["config", "user.name", "Arc Lab"])?;
        git(&root, &["config", "user.email", "arc-lab@tug.invalid"])?;
        git(&root, &["config", "commit.gpgsign", "false"])?;
        for (path, body) in files {
            let full = root.join(path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("creating {}: {e}", parent.display()))?;
            }
            std::fs::write(&full, body).map_err(|e| format!("writing {}: {e}", full.display()))?;
        }
        let config_dir = root.join(".tugtool");
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| format!("creating {}: {e}", config_dir.display()))?;
        std::fs::write(config_dir.join("config.toml"), config_toml(surfaces))
            .map_err(|e| format!("writing config.toml: {e}"))?;
        // A docs/ directory for the docs surface to claim, so a round that
        // touches it is one the exam checks.
        std::fs::create_dir_all(root.join("docs")).map_err(|e| format!("creating docs/: {e}"))?;
        std::fs::write(root.join("docs").join("README.md"), "# lab\n")
            .map_err(|e| format!("writing docs/README.md: {e}"))?;
        git(&root, &["add", "-A"])?;
        git(&root, &["commit", "-q", "-m", "base"])?;
        Ok(Self { root })
    }
}

/// Run `cmd` and return its stdout, with stderr in the error.
pub fn run_capturing(cmd: &mut Command) -> Result<String, String> {
    let program = cmd.get_program().to_string_lossy().into_owned();
    let out = cmd
        .output()
        .map_err(|e| format!("spawning {program}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{program} failed ({}): {}{}",
            out.status,
            String::from_utf8_lossy(&out.stdout).trim(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_toml_declares_each_surface() {
        let toml = config_toml(&[
            Surface {
                name: "docs",
                paths: &["docs/"],
                check: &["true"],
            },
            Surface {
                name: "red",
                paths: &["src/"],
                check: &["sh -c 'exit 1'"],
            },
        ]);
        assert!(toml.contains("[tugtool.arc]\n"));
        assert!(toml.contains(
            "[[tugtool.arc.surface]]\nname = \"docs\"\npaths = [\"docs/\"]\ncheck = [\"true\"]\n"
        ));
        assert!(
            toml.contains("name = \"red\"\npaths = [\"src/\"]\ncheck = [\"sh -c 'exit 1'\"]\n")
        );
        let parsed: toml::Value = toml::from_str(&toml).expect("the config parses");
        assert_eq!(
            parsed["tugtool"]["arc"]["surface"].as_array().map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn build_makes_a_repository_on_main_with_the_files_and_the_config() {
        let temp = tempfile::tempdir().unwrap();
        let project = LabProject::build(
            temp.path(),
            &[
                ("f.txt", "one\n".to_string()),
                ("sub/g.txt", "g\n".to_string()),
            ],
            &[Surface {
                name: "docs",
                paths: &["docs/"],
                check: &["true"],
            }],
        )
        .expect("builds");
        let root = project.root.as_path();
        assert_eq!(
            git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(),
            "main"
        );
        assert_eq!(git(root, &["status", "--porcelain"]).unwrap(), "");
        assert_eq!(
            git(root, &["ls-files"])
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            vec![
                ".tugtool/config.toml",
                "docs/README.md",
                "f.txt",
                "sub/g.txt"
            ]
        );
        assert!(
            LabProject::build(temp.path(), &[], &[]).is_err(),
            "a run directory is never reused"
        );
    }
}
