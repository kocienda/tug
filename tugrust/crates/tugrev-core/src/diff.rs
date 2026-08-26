//! The unified diff a preview shows and an apply prints.
//!
//! Presentation only. Hunk identity — the ids a receipt carries — is the
//! landing engine's, computed from `git diff`, and nothing here feeds it.

/// Render `before` → `after` as a unified diff with the usual `---`/`+++`/`@@`
/// framing. Identical content renders as the empty string.
pub fn unified_diff(path: &str, before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    similar::TextDiff::from_lines(before, after)
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{path}"), &format!("b/{path}"))
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_known_pair_renders_with_the_standard_framing() {
        let before = "one\ntwo\nthree\n";
        let after = "one\ndeux\nthree\n";
        assert_eq!(
            unified_diff("a.txt", before, after),
            "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+deux\n three\n"
        );
    }

    #[test]
    fn identical_content_renders_nothing() {
        assert_eq!(unified_diff("a.txt", "same\n", "same\n"), "");
    }
}
