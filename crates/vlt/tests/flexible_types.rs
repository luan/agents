use std::fs;

use assert_cmd::Command;
use predicates::prelude::*;

#[test]
fn list_type_without_value_lists_available_custom_types() {
    let vault = tempfile::tempdir().expect("vault tempdir");
    let dir = vault.path().join("proj").join("decision");
    fs::create_dir_all(&dir).expect("custom type dir");
    fs::write(
        dir.join("custom-note.md"),
        "---\ntopic: custom note\n---\nbody\n",
    )
    .expect("custom note");

    Command::cargo_bin("vlt")
        .expect("vlt binary")
        .env("CT_BLUEPRINTS_DIR", vault.path())
        .args(["list", "--type"])
        .assert()
        .success()
        .stdout(predicate::str::contains("decision"));
}

#[test]
fn list_and_read_accept_custom_type_filters() {
    let vault = tempfile::tempdir().expect("vault tempdir");
    let dir = vault.path().join("proj").join("decision");
    fs::create_dir_all(&dir).expect("custom type dir");
    fs::write(
        dir.join("custom-note.md"),
        "---\ntopic: custom note\n---\nbody\n",
    )
    .expect("custom note");

    Command::cargo_bin("vlt")
        .expect("vlt binary")
        .env("CT_BLUEPRINTS_DIR", vault.path())
        .args(["list", "--all", "--type", "decision", "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("custom note"));

    Command::cargo_bin("vlt")
        .expect("vlt binary")
        .env("CT_BLUEPRINTS_DIR", vault.path())
        .args(["read", "--type", "decision", "custom-note"])
        .assert()
        .success()
        .stdout(predicate::str::contains("body"));
}
