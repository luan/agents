use std::io::Write;
use std::process::{Command, Stdio};

use assert_fs::fixture::FileWriteStr;
use assert_fs::NamedTempFile;
use pretty_assertions::assert_eq;
use rstest::rstest;
use serde_json::Value;

const ONE_PIXEL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

#[rstest]
fn returns_a_native_image_attachment() {
    let image = NamedTempFile::new("pixel.png").expect("temp image");
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, ONE_PIXEL_PNG)
        .expect("valid fixture");
    std::fs::write(image.path(), bytes).expect("write image");

    let output = run(&serde_json::json!({ "path": image.path() }).to_string());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).expect("structured output");
    assert_eq!(result["detail"], "high");
    assert_eq!(result["width"], 1);
    assert_eq!(result["height"], 1);
    assert!(result["image_url"]
        .as_str()
        .expect("image URL")
        .starts_with("data:image/png;base64,"));
}

#[rstest]
#[case(None, "high", 2048)]
#[case(Some("high"), "high", 2048)]
#[case(Some("original"), "original", 2050)]
fn applies_requested_image_detail(
    #[case] detail: Option<&str>,
    #[case] expected_detail: &str,
    #[case] expected_width: u64,
) {
    let image = NamedTempFile::new("wide.png").expect("temp image");
    image::RgbaImage::from_pixel(2050, 2, image::Rgba([255, 0, 0, 255]))
        .save(image.path())
        .expect("write image");
    let mut input = serde_json::json!({ "path": image.path() });
    if let Some(detail) = detail {
        input["detail"] = detail.into();
    }

    let output = run(&input.to_string());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).expect("structured output");
    assert_eq!(result["detail"], expected_detail);
    assert_eq!(result["width"], expected_width);
}

#[rstest]
fn rejects_text_files() {
    let file = NamedTempFile::new("not-image.txt").expect("temp file");
    file.write_str("hello").expect("write text");

    let output = run(&serde_json::json!({ "path": file.path() }).to_string());
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("unable to process image"));
}

fn run(input: &str) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_view_image"))
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start view_image");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(input.as_bytes())
        .expect("write arguments");
    child.wait_with_output().expect("wait for view_image")
}
