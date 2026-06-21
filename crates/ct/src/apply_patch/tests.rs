// Integration tests for the Phase 2 `apply()` return shape. These verify the
// public API of the library without touching the MCP layer or telemetry db —
// a successful apply must surface an anchor attempt + a file fingerprint, and
// a failed apply must still carry whatever was accumulated up to the error.

use std::fs;

use tempfile::TempDir;

use super::apply;

#[test]
fn success_returns_attempt_and_fingerprint() {
    let tmp = TempDir::new().unwrap();
    let content = "alpha\nbeta\ngamma\n";
    fs::write(tmp.path().join("f.txt"), content).unwrap();

    let patch = concat!(
        "*** Begin Patch\n",
        "*** Update File: f.txt\n",
        "@@\n",
        " alpha\n",
        "-beta\n",
        "+BETA\n",
        " gamma\n",
        "*** End Patch\n",
    );

    let outcome = apply(patch, tmp.path(), true).expect("apply should succeed");
    assert_eq!(outcome.changes.len(), 1);
    assert_eq!(outcome.attempts.len(), 1);
    assert!(outcome.attempts[0].success);
    assert_eq!(outcome.attempts[0].fuzzy_tier.as_deref(), Some("exact"));
    assert_eq!(outcome.attempts[0].file_path, "f.txt");

    assert_eq!(outcome.fingerprints.len(), 1);
    let (path, fp) = &outcome.fingerprints[0];
    assert_eq!(path, "f.txt");
    let expected_sha = crate::apply_patch::sha1_hex(content.as_bytes());
    assert_eq!(fp.sha1, expected_sha);
}

#[test]
fn failure_returns_attempt_and_fingerprint() {
    let tmp = TempDir::new().unwrap();
    let content = "one\ntwo\nthree\n";
    fs::write(tmp.path().join("g.txt"), content).unwrap();

    // `delta` doesn't exist in the file — this hunk will miss context.
    let patch = concat!(
        "*** Begin Patch\n",
        "*** Update File: g.txt\n",
        "@@\n",
        "-delta\n",
        "+DELTA\n",
        "*** End Patch\n",
    );

    let failure = apply(patch, tmp.path(), true).expect_err("apply should fail");
    assert_eq!(failure.attempts.len(), 1);
    assert!(!failure.attempts[0].success);
    assert_eq!(failure.attempts[0].file_path, "g.txt");

    // The file was read before the chunk failure, so fingerprint is recorded.
    assert_eq!(failure.fingerprints.len(), 1);
    let (path, fp) = &failure.fingerprints[0];
    assert_eq!(path, "g.txt");
    let expected_sha = crate::apply_patch::sha1_hex(content.as_bytes());
    assert_eq!(fp.sha1, expected_sha);
}
