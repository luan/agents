use rstest::rstest;
use voice_host::protocol::*;

#[rstest]
fn commands_are_closed_and_bounded() {
    assert!(parse_command(r#"{"type":"unknown"}"#).is_err());
    assert!(parse_command(r#"{"type":"stop","extra":true}"#).is_err());
    assert!(parse_command(r#"{"type":"set_input_muted","muted":true}"#).is_ok());
    assert!(parse_command(r#"{"type":"set_input_muted","muted":"yes"}"#).is_err());
    assert!(parse_command(r#"{"type":"start_v3_bridge"}"#).is_ok());
    assert!(
        Command::SendPcm {
            audio: "AA==".to_owned(),
            sample_rate: 48_000,
            num_channels: 1,
        }
        .validate()
        .is_err()
    );
    assert!(
        Command::StartDictation {
            microphone: Some("x".repeat(MAX_DEVICE_BYTES + 1)),
        }
        .validate()
        .is_err()
    );
    assert!(
        Command::ApplyAnswer {
            sdp: "x".repeat(MAX_SDP_BYTES + 1)
        }
        .validate()
        .is_err()
    );
}
