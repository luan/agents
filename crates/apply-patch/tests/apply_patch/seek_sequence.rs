use codex_apply_patch::seek_sequence::seek_sequence;
use pretty_assertions::assert_eq;
use std::string::ToString;

fn to_vec(strings: &[&str]) -> Vec<String> {
    strings.iter().map(ToString::to_string).collect()
}

#[rstest::rstest]
#[case::exact(&["foo", "bar", "baz"], &["bar", "baz"], Some(1))]
#[case::trailing_whitespace(&["foo   ", "bar\t\t"], &["foo", "bar"], Some(0))]
#[case::surrounding_whitespace(&["    foo   ", "   bar\t"], &["foo", "bar"], Some(0))]
#[case::pattern_too_long(&["just one line"], &["too", "many", "lines"], None)]
fn seek_sequence_matches_expected_lines(
    #[case] lines: &[&str],
    #[case] pattern: &[&str],
    #[case] expected: Option<usize>,
) {
    let lines = to_vec(lines);
    let pattern = to_vec(pattern);
    assert_eq!(
        seek_sequence(&lines, &pattern, /*start*/ 0, /*eof*/ false),
        expected
    );
}
