use notebook_host::wire::{decode, encode};
use pretty_assertions::assert_eq;
use proptest::prelude::*;
use serde_json::json;

proptest! {
    #[test]
    fn authenticated_messages_preserve_content(text in ".{0,4096}", key in "[a-zA-Z0-9]{1,80}") {
        let content = json!({"code": text, "allow_stdin":false});
        let (_, message) = encode("execute_request", content.clone(), &key).unwrap();
        let restored = decode(message, &key).unwrap();
        assert_eq!(restored["content"], content);
        assert_eq!(restored["header"]["msg_type"], "execute_request");
    }

    #[test]
    fn a_different_key_cannot_forge_notebook_output(key in "[a-z]{1,30}") {
        let (_, message) = encode("stream", json!({"text":"forged"}), &key).unwrap();
        prop_assert!(decode(message, &(key + "!")).is_err());
    }
}
