import XCTest

// The case table is also the input list for
// `tests/build-info/test-slug-parity.sh`, which checks that the bash
// slugifier agrees with this one on every row. Its extractor reads the
// first quoted string of each row between `let branchSlugCases:` and the
// closing `]` at column zero, so keep one case per line and no escaped
// quotes inside an input.
let branchSlugCases: [(input: String, expected: String)] = [
    // The three examples called out in the plan task list.
    ("feat/foo",      "feat-foo"),
    ("Dev-1",        "dev-1"),
    ("wip/foo bar",   "wip-foo-bar"),

    // Identity cases — values already valid as slugs.
    ("main",          "main"),
    ("dev",           "dev"),
    ("0",             "0"),

    // Hyphen runs survive (already collapsed/trimmed).
    ("foo-bar-baz",   "foo-bar-baz"),

    // Multiple slashes all become hyphens.
    ("a/b/c",         "a-b-c"),

    // Mixed-case and digits.
    ("Dev-Wake-1",   "dev-wake-1"),
    ("ABC123",        "abc123"),

    // Whitespace becomes a separator.
    ("hello world",   "hello-world"),
    ("  pad  ",       "pad"),

    // Underscore is a separator.
    ("foo_bar",       "foo-bar"),

    // Punctuation becomes separators; runs collapse.
    ("v1.2.3",        "v1-2-3"),
    ("feature#42",    "feature-42"),
    ("a@b.c",         "a-b-c"),

    // Runs of non-slug chars collapse to a single dash.
    ("a///b",         "a-b"),
    ("foo   bar",     "foo-bar"),

    // Leading/trailing non-slug chars trim away cleanly.
    ("--leading",     "leading"),
    ("trailing--",    "trailing"),

    // Unicode becomes separators (only ASCII a-z, 0-9 survive).
    ("café",          "caf"),
    ("naïve",         "na-ve"),

    // Detached-HEAD shape produced by capture-build-info.sh (already
    // slug-safe — verify identity).
    ("detached-abcd1234", "detached-abcd1234"),

    // Empty input is empty out — callers are responsible for composing
    // a fallback if they need one.
    ("",              ""),
]

final class BranchSlugTests: XCTestCase {
    func testEveryCaseSlugsAsExpected() {
        for c in branchSlugCases {
            XCTAssertEqual(BranchSlug.compute(c.input), c.expected, "BranchSlug.compute(\"\(c.input)\")")
        }
    }
}
