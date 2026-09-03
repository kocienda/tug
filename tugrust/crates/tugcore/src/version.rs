//! The leading-`MAJOR.MINOR.PATCH` version token, read out of a tool's own
//! chatter.
//!
//! Every external binary Tug asks for a version answers in its own dialect —
//! `claude --version` suffixes its name, `git --version` prefixes two words and
//! may suffix Apple's build number, and a release-channel file is the bare
//! version alone. All three lead with the token, so one reader serves them all
//! rather than each caller growing its own near-copy.

/// Take the leading `MAJOR.MINOR.PATCH[-pre]` token out of the first line of
/// `text`, ignoring anything after it. Anything else — an HTML error page, a
/// usage message, a two-component version — resolves to `None` rather than
/// being shown to the user as a version.
pub fn parse_leading_version(text: &str) -> Option<String> {
    let token = text.trim().lines().next()?.split_whitespace().next()?;
    let mut parts = token.splitn(3, '.');
    let major = parts.next()?;
    let minor = parts.next()?;
    let patch = parts.next()?;
    let numeric = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    // A pre-release rides the patch in three spellings — `0-rc.1` (semver, as
    // Claude Code answers), `0+build`, and `0.rc1` (git's own) — and all three
    // are versions we can name, so the patch is read up to whichever arrives.
    let patch_numeric = patch.split(['-', '+', '.']).next().unwrap_or_default();
    if numeric(major) && numeric(minor) && numeric(patch_numeric) {
        Some(token.to_string())
    } else {
        None
    }
}

/// The same token, skipping `skip` leading whitespace-separated words first —
/// `git --version` answers `git version 2.39.5 (Apple Git-154)`, so its version
/// is the third word rather than the first.
pub fn parse_version_after_words(text: &str, skip: usize) -> Option<String> {
    let line = text.trim().lines().next()?;
    let rest = line.split_whitespace().nth(skip)?;
    parse_leading_version(rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_cli_version_line() {
        assert_eq!(
            parse_leading_version("2.1.222 (Claude Code)\n"),
            Some("2.1.222".to_string())
        );
    }

    #[test]
    fn parses_a_bare_channel_version() {
        assert_eq!(
            parse_leading_version("2.1.226\n"),
            Some("2.1.226".to_string())
        );
        assert_eq!(
            parse_leading_version("2.2.0-rc.1\n"),
            Some("2.2.0-rc.1".to_string())
        );
    }

    #[test]
    fn rejects_content_that_is_not_a_version() {
        // An HTML error page from the channel URL, or a CLI that answered with
        // usage text, must read as "unknown" rather than land in the UI.
        assert_eq!(parse_leading_version("<!doctype html>"), None);
        assert_eq!(parse_leading_version(""), None);
        assert_eq!(parse_leading_version("Usage: claude [options]"), None);
        assert_eq!(parse_leading_version("2.1"), None);
    }

    #[test]
    fn parses_gits_two_word_preamble() {
        // Apple's git, Homebrew's git, and a source build, in that order.
        assert_eq!(
            parse_version_after_words("git version 2.39.5 (Apple Git-154)\n", 2),
            Some("2.39.5".to_string())
        );
        assert_eq!(
            parse_version_after_words("git version 2.51.0\n", 2),
            Some("2.51.0".to_string())
        );
        assert_eq!(
            parse_version_after_words("git version 2.23.0.rc1\n", 2),
            Some("2.23.0.rc1".to_string())
        );
    }

    #[test]
    fn rejects_git_output_that_is_not_a_version() {
        assert_eq!(parse_version_after_words("git version", 2), None);
        assert_eq!(parse_version_after_words("", 2), None);
        assert_eq!(
            parse_version_after_words("xcode-select: note: no developer tools", 2),
            None
        );
    }
}
