//! What kind of line a numstat row counts, told by the file's path.
//!
//! A chart that sums lines changed is only as honest as what it sums: a
//! fixture JSON, a lockfile or a design document moves the figure as much as
//! source does and says nothing about the work. So every path a line recipe
//! reads is classified here as source, tests, data or docs, and the recipe
//! chooses which kinds it counts.
//!
//! Classification is by path alone, through glob patterns per kind. The
//! built-in patterns fit most layouts; a project whose layout differs states
//! its own in `[tugtool.lines]`, one kind at a time. Data is tried first, then
//! docs, then tests, and a path none of them claims is source — so a fixture
//! under a tests directory is data and a README beside the tests is prose.

use glob::{MatchOptions, Pattern};

/// The kind of file a line was changed in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum LineKind {
    Source,
    Tests,
    Data,
    Docs,
}

impl LineKind {
    /// Every kind, in the order a chart names them.
    pub const ALL: [LineKind; 4] = [
        LineKind::Source,
        LineKind::Tests,
        LineKind::Data,
        LineKind::Docs,
    ];

    pub fn name(self) -> &'static str {
        match self {
            LineKind::Source => "source",
            LineKind::Tests => "tests",
            LineKind::Data => "data",
            LineKind::Docs => "docs",
        }
    }

    fn index(self) -> usize {
        match self {
            LineKind::Source => 0,
            LineKind::Tests => 1,
            LineKind::Data => 2,
            LineKind::Docs => 3,
        }
    }
}

const DEFAULT_DATA: &[&str] = &[
    "**/*.json",
    "**/*.lock",
    "**/*.lockb",
    "**/*.ai",
    "**/*.plist",
    "**/*.svg",
    "**/*.toml",
    "**/*.snap",
];

const DEFAULT_DOCS: &[&str] = &["**/*.md", "**/*.mdx", "**/*.rst"];

const DEFAULT_TESTS: &[&str] = &[
    "**/__tests__/**",
    "**/tests/**",
    "**/test/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/*_test.*",
    "**/*Tests/**",
];

const MATCH: MatchOptions = MatchOptions {
    case_sensitive: true,
    require_literal_separator: true,
    require_literal_leading_dot: false,
};

/// One pattern as written, with the forms it is matched in. A pattern that
/// begins `**/` is also tried without it, so it claims a path at the root as
/// well as a nested one whatever the glob crate makes of a leading `**/`.
#[derive(Debug, Clone)]
struct KindPattern {
    patterns: Vec<Pattern>,
}

impl KindPattern {
    fn compile(text: &str) -> Result<KindPattern, String> {
        let invalid = |e: glob::PatternError| format!("invalid line pattern `{text}`: {e}");
        let mut patterns = vec![Pattern::new(text).map_err(invalid)?];
        if let Some(rest) = text.strip_prefix("**/")
            && !rest.is_empty()
        {
            patterns.push(Pattern::new(rest).map_err(invalid)?);
        }
        Ok(KindPattern { patterns })
    }

    fn matches(&self, path: &str) -> bool {
        self.patterns.iter().any(|p| p.matches_with(path, MATCH))
    }
}

/// The compiled patterns of the three kinds a path can be claimed by.
#[derive(Debug, Clone)]
pub struct LineKinds {
    tests: Vec<KindPattern>,
    data: Vec<KindPattern>,
    docs: Vec<KindPattern>,
}

impl LineKinds {
    /// The built-in patterns.
    pub fn defaults() -> LineKinds {
        Self::from_patterns(None, None, None).expect("the built-in line patterns compile")
    }

    /// Each `None` keeps that kind's built-in patterns and each `Some`
    /// replaces them whole. A pattern that does not compile is the error,
    /// naming it.
    pub fn from_patterns(
        tests: Option<&[String]>,
        data: Option<&[String]>,
        docs: Option<&[String]>,
    ) -> Result<LineKinds, String> {
        fn compile(
            declared: Option<&[String]>,
            defaults: &[&str],
        ) -> Result<Vec<KindPattern>, String> {
            match declared {
                Some(list) => list.iter().map(|p| KindPattern::compile(p)).collect(),
                None => defaults.iter().map(|p| KindPattern::compile(p)).collect(),
            }
        }
        Ok(LineKinds {
            tests: compile(tests, DEFAULT_TESTS)?,
            data: compile(data, DEFAULT_DATA)?,
            docs: compile(docs, DEFAULT_DOCS)?,
        })
    }

    /// The kind of `path`, a repository-relative path as numstat reports it.
    pub fn classify(&self, path: &str) -> LineKind {
        let claims = |patterns: &[KindPattern]| patterns.iter().any(|p| p.matches(path));
        if claims(&self.data) {
            LineKind::Data
        } else if claims(&self.docs) {
            LineKind::Docs
        } else if claims(&self.tests) {
            LineKind::Tests
        } else {
            LineKind::Source
        }
    }
}

/// Which kinds a recipe counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KindSet {
    held: [bool; 4],
}

impl KindSet {
    /// `code` is source and tests, `all` every kind, and a kind's own name
    /// that kind alone. Anything else is `None`.
    pub fn parse(name: &str) -> Option<KindSet> {
        let held = match name {
            "code" => [true, true, false, false],
            "all" => [true; 4],
            "source" => [true, false, false, false],
            "tests" => [false, true, false, false],
            "data" => [false, false, true, false],
            "docs" => [false, false, false, true],
            _ => return None,
        };
        Some(KindSet { held })
    }

    pub fn holds(self, kind: LineKind) -> bool {
        self.held[kind.index()]
    }

    /// The kinds held, in [`LineKind::ALL`] order.
    pub fn kinds(self) -> Vec<LineKind> {
        LineKind::ALL
            .into_iter()
            .filter(|kind| self.holds(*kind))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_patterns_claim_nested_and_root_level_paths() {
        let kinds = LineKinds::defaults();
        for (path, kind) in [
            ("tests/a.rs", LineKind::Tests),
            ("x/tests/a.rs", LineKind::Tests),
            ("test/a.rs", LineKind::Tests),
            ("x/__tests__/a.ts", LineKind::Tests),
            ("a.test.ts", LineKind::Tests),
            ("x/y/a.test.ts", LineKind::Tests),
            ("a.spec.ts", LineKind::Tests),
            ("x/a_test.go", LineKind::Tests),
            ("tugapp/TugTests/MenuBarBuilderTests.swift", LineKind::Tests),
            ("README.md", LineKind::Docs),
            ("docs/a/b.md", LineKind::Docs),
            ("x/a.rst", LineKind::Docs),
            ("Cargo.toml", LineKind::Data),
            ("x/Cargo.lock", LineKind::Data),
            ("bun.lockb", LineKind::Data),
            ("resources/dmg-preview.ai", LineKind::Data),
            ("tugapp/Info.plist", LineKind::Data),
            ("x/icon.svg", LineKind::Data),
            ("x/__snapshots__/a.snap", LineKind::Data),
            ("catalog.json", LineKind::Data),
            ("src/main.rs", LineKind::Source),
            ("a/one.txt", LineKind::Source),
            ("main.rs", LineKind::Source),
        ] {
            assert_eq!(kinds.classify(path), kind, "{path}");
        }
    }

    #[test]
    fn data_wins_over_docs_and_docs_over_tests() {
        let kinds = LineKinds::defaults();
        assert_eq!(kinds.classify("tests/fixtures/big.json"), LineKind::Data);
        assert_eq!(kinds.classify("tests/README.md"), LineKind::Docs);
    }

    #[test]
    fn a_declared_kind_replaces_its_defaults_and_leaves_the_others() {
        let kinds = LineKinds::from_patterns(Some(&["spec/**".to_string()]), None, None).unwrap();
        assert_eq!(kinds.classify("spec/a.rb"), LineKind::Tests);
        assert_eq!(kinds.classify("tests/a.rs"), LineKind::Source);
        assert_eq!(kinds.classify("x/a.json"), LineKind::Data);
        assert_eq!(kinds.classify("a.md"), LineKind::Docs);
    }

    #[test]
    fn an_invalid_pattern_is_refused_by_name() {
        let err = LineKinds::from_patterns(None, Some(&["[".to_string()]), None).unwrap_err();
        assert!(err.contains("`[`"), "{err}");
    }

    #[test]
    fn each_set_name_holds_its_kinds() {
        use LineKind::*;
        for (name, held) in [
            ("code", vec![Source, Tests]),
            ("all", vec![Source, Tests, Data, Docs]),
            ("source", vec![Source]),
            ("tests", vec![Tests]),
            ("data", vec![Data]),
            ("docs", vec![Docs]),
        ] {
            let set = KindSet::parse(name).expect(name);
            assert_eq!(set.kinds(), held, "{name}");
            for kind in LineKind::ALL {
                assert_eq!(set.holds(kind), held.contains(&kind), "{name} {kind:?}");
            }
        }
        assert_eq!(KindSet::parse("everything"), None);
    }
}
