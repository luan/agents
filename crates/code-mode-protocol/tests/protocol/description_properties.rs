use pretty_assertions::assert_eq;
use proptest::prelude::*;
use proptest_derive::Arbitrary;

use code_mode_protocol::normalize_code_mode_identifier;

#[derive(Debug, Arbitrary)]
struct Identifier(#[proptest(regex = "[A-Za-z0-9_./:-]{0,32}")] String);

proptest! {
    // Property: normalization is a canonicalization operation, so normalizing
    // an already normalized identifier does not change it.
    #[test]
    fn identifier_normalization_is_idempotent(input: Identifier) {
        let once = normalize_code_mode_identifier(&input.0);
        assert_eq!(normalize_code_mode_identifier(&once), once);
    }
}
