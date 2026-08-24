use assert_fs::TempDir;
use codex_apply_patch::Hunk::*;
use codex_apply_patch::ParseError::*;
use codex_apply_patch::absolute_path::AbsolutePathBuf;
use codex_apply_patch::path_uri::PathUri;
use codex_apply_patch::{
    ApplyPatchArgs, ParseMode, UpdateFileChunk, parse_patch, parse_patch_text,
};
use pretty_assertions::assert_eq;
use proptest::prelude::*;
use proptest_derive::Arbitrary;
use std::path::PathBuf;

trait PathBufExt {
    fn abs(&self) -> AbsolutePathBuf;
}

impl PathBufExt for PathBuf {
    fn abs(&self) -> AbsolutePathBuf {
        AbsolutePathBuf::from_absolute_path_checked(self).expect("path should be absolute")
    }
}

#[test]
fn test_parse_patch() {
    assert_eq!(
        parse_patch_text("bad", ParseMode::Strict),
        Err(InvalidPatchError(
            "The first line of the patch must be '*** Begin Patch'".to_string()
        ))
    );
    assert_eq!(
        parse_patch_text("*** Begin Patch\nbad", ParseMode::Strict),
        Err(InvalidPatchError(
            "The last line of the patch must be '*** End Patch'".to_string()
        ))
    );

    assert_eq!(
        parse_patch_text(
            concat!(
                "*** Begin Patch",
                " ",
                "\n*** Add File: foo\n+hi\n",
                " ",
                "*** End Patch"
            ),
            ParseMode::Strict
        )
        .unwrap()
        .hunks,
        vec![AddFile {
            path: PathBuf::from("foo"),
            contents: "hi\n".to_string()
        }]
    );
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Update File: test.py\n\
             *** End Patch",
            ParseMode::Strict
        ),
        Err(InvalidHunkError {
            message: "Update file hunk for path 'test.py' is empty".to_string(),
            line_number: 2,
        })
    );
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** End Patch",
            ParseMode::Strict
        )
        .unwrap()
        .hunks,
        Vec::new()
    );
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Add File: path/add.py\n\
             +abc\n\
             +def\n\
             *** Delete File: path/delete.py\n\
             *** Update File: path/update.py\n\
             *** Move to: path/update2.py\n\
             @@ def f():\n\
             -    pass\n\
             +    return 123\n\
             *** End Patch",
            ParseMode::Strict
        )
        .unwrap()
        .hunks,
        vec![
            AddFile {
                path: PathBuf::from("path/add.py"),
                contents: "abc\ndef\n".to_string()
            },
            DeleteFile {
                path: PathBuf::from("path/delete.py")
            },
            UpdateFile {
                path: PathBuf::from("path/update.py"),
                move_path: Some(PathBuf::from("path/update2.py")),
                chunks: vec![UpdateFileChunk {
                    change_context: Some("def f():".to_string()),
                    old_lines: vec!["    pass".to_string()],
                    new_lines: vec!["    return 123".to_string()],
                    is_end_of_file: false
                }]
            }
        ]
    );
    // Update hunk followed by another hunk (Add File).
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Update File: file.py\n\
             @@\n\
             +line\n\
             *** Add File: other.py\n\
             +content\n\
             *** End Patch",
            ParseMode::Strict
        )
        .unwrap()
        .hunks,
        vec![
            UpdateFile {
                path: PathBuf::from("file.py"),
                move_path: None,
                chunks: vec![UpdateFileChunk {
                    change_context: None,
                    old_lines: vec![],
                    new_lines: vec!["line".to_string()],
                    is_end_of_file: false
                }],
            },
            AddFile {
                path: PathBuf::from("other.py"),
                contents: "content\n".to_string()
            }
        ]
    );

    // Update hunk without an explicit @@ header for the first chunk should parse.
    // Use a raw string to preserve the leading space diff marker on the context line.
    assert_eq!(
        parse_patch_text(
            r"*** Begin Patch
*** Update File: file2.py
 import foo
+bar
*** End Patch",
            ParseMode::Strict
        )
        .unwrap()
        .hunks,
        vec![UpdateFile {
            path: PathBuf::from("file2.py"),
            move_path: None,
            chunks: vec![UpdateFileChunk {
                change_context: None,
                old_lines: vec!["import foo".to_string()],
                new_lines: vec!["import foo".to_string(), "bar".to_string()],
                is_end_of_file: false,
            }],
        }]
    );
}

#[test]
fn test_parse_patch_preserves_end_of_file_marker() {
    let patch =
        "*** Begin Patch\n*** Update File: file.txt\n@@\n+quux\n*** End of File\n\n*** End Patch";
    assert_eq!(
        parse_patch(patch),
        Ok(ApplyPatchArgs {
            hunks: vec![UpdateFile {
                path: PathBuf::from("file.txt"),
                move_path: None,
                chunks: vec![UpdateFileChunk {
                    change_context: None,
                    old_lines: Vec::new(),
                    new_lines: vec!["quux".to_string()],
                    is_end_of_file: true,
                }],
            }],
            patch: patch.to_string(),
            workdir: None,
            environment_id: None,
        })
    );
}

#[test]
fn test_parse_patch_accepts_relative_and_absolute_hunk_paths() {
    let dir = TempDir::new().unwrap();
    let absolute_delete = dir.path().join("absolute-delete.py").abs();
    let absolute_update = dir.path().join("absolute-update.py").abs();
    let patch_text = format!(
        r"*** Begin Patch
*** Add File: relative-add.py
+content
*** Delete File: {}
*** Update File: {}
@@
-old
+new
*** End Patch",
        absolute_delete.display(),
        absolute_update.display()
    );

    assert_eq!(
        parse_patch_text(&patch_text, ParseMode::Strict)
            .unwrap()
            .hunks,
        vec![
            AddFile {
                path: PathBuf::from("relative-add.py"),
                contents: "content\n".to_string()
            },
            DeleteFile {
                path: absolute_delete.to_path_buf()
            },
            UpdateFile {
                path: absolute_update.to_path_buf(),
                move_path: None,
                chunks: vec![UpdateFileChunk {
                    change_context: None,
                    old_lines: vec!["old".to_string()],
                    new_lines: vec!["new".to_string()],
                    is_end_of_file: false
                }]
            },
        ]
    );
}

#[test]
fn test_hunk_resolve_path_accepts_relative_and_absolute_paths() {
    let cwd_dir = TempDir::new().unwrap();
    let cwd = PathUri::from_host_native_path(cwd_dir.path()).unwrap();
    let absolute_dir = TempDir::new().unwrap();
    let absolute_add = absolute_dir.path().join("absolute-add.py").abs();
    let absolute_delete = absolute_dir.path().join("absolute-delete.py").abs();
    let absolute_update = absolute_dir.path().join("absolute-update.py").abs();

    for (hunk, expected_path) in [
        (
            AddFile {
                path: PathBuf::from("relative-add.py"),
                contents: String::new(),
            },
            cwd.join("relative-add.py").unwrap(),
        ),
        (
            DeleteFile {
                path: PathBuf::from("relative-delete.py"),
            },
            cwd.join("relative-delete.py").unwrap(),
        ),
        (
            UpdateFile {
                path: PathBuf::from("relative-update.py"),
                move_path: None,
                chunks: Vec::new(),
            },
            cwd.join("relative-update.py").unwrap(),
        ),
        (
            AddFile {
                path: absolute_add.to_path_buf(),
                contents: String::new(),
            },
            PathUri::from_abs_path(&absolute_add),
        ),
        (
            DeleteFile {
                path: absolute_delete.to_path_buf(),
            },
            PathUri::from_abs_path(&absolute_delete),
        ),
        (
            UpdateFile {
                path: absolute_update.to_path_buf(),
                move_path: None,
                chunks: Vec::new(),
            },
            PathUri::from_abs_path(&absolute_update),
        ),
    ] {
        assert_eq!(hunk.resolve_path(&cwd), Ok(expected_path));
    }
}

#[test]
fn test_parse_patch_lenient() {
    let patch_text = r"*** Begin Patch
*** Update File: file2.py
 import foo
+bar
*** End Patch";
    let expected_patch = vec![UpdateFile {
        path: PathBuf::from("file2.py"),
        move_path: None,
        chunks: vec![UpdateFileChunk {
            change_context: None,
            old_lines: vec!["import foo".to_string()],
            new_lines: vec!["import foo".to_string(), "bar".to_string()],
            is_end_of_file: false,
        }],
    }];
    let expected_error =
        InvalidPatchError("The first line of the patch must be '*** Begin Patch'".to_string());

    let patch_text_in_heredoc = format!("<<EOF\n{patch_text}\nEOF\n");
    assert_eq!(
        parse_patch_text(&patch_text_in_heredoc, ParseMode::Strict),
        Err(expected_error.clone())
    );
    assert_eq!(
        parse_patch_text(&patch_text_in_heredoc, ParseMode::Lenient),
        Ok(ApplyPatchArgs {
            hunks: expected_patch.clone(),
            patch: patch_text.to_string(),
            workdir: None,
            environment_id: None,
        })
    );

    let patch_text_in_single_quoted_heredoc = format!("<<'EOF'\n{patch_text}\nEOF\n");
    assert_eq!(
        parse_patch_text(&patch_text_in_single_quoted_heredoc, ParseMode::Strict),
        Err(expected_error.clone())
    );
    assert_eq!(
        parse_patch_text(&patch_text_in_single_quoted_heredoc, ParseMode::Lenient),
        Ok(ApplyPatchArgs {
            hunks: expected_patch.clone(),
            patch: patch_text.to_string(),
            workdir: None,
            environment_id: None,
        })
    );

    let patch_text_in_double_quoted_heredoc = format!("<<\"EOF\"\n{patch_text}\nEOF\n");
    assert_eq!(
        parse_patch_text(&patch_text_in_double_quoted_heredoc, ParseMode::Strict),
        Err(expected_error.clone())
    );
    assert_eq!(
        parse_patch_text(&patch_text_in_double_quoted_heredoc, ParseMode::Lenient),
        Ok(ApplyPatchArgs {
            hunks: expected_patch,
            patch: patch_text.to_string(),
            workdir: None,
            environment_id: None,
        })
    );

    let patch_text_in_mismatched_quotes_heredoc = format!("<<\"EOF'\n{patch_text}\nEOF\n");
    assert_eq!(
        parse_patch_text(&patch_text_in_mismatched_quotes_heredoc, ParseMode::Strict),
        Err(expected_error.clone())
    );
    assert_eq!(
        parse_patch_text(&patch_text_in_mismatched_quotes_heredoc, ParseMode::Lenient),
        Err(expected_error.clone())
    );

    let patch_text_with_missing_closing_heredoc =
        "<<EOF\n*** Begin Patch\n*** Update File: file2.py\nEOF\n".to_string();
    assert_eq!(
        parse_patch_text(&patch_text_with_missing_closing_heredoc, ParseMode::Strict),
        Err(expected_error)
    );
    assert_eq!(
        parse_patch_text(&patch_text_with_missing_closing_heredoc, ParseMode::Lenient),
        Err(InvalidPatchError(
            "The last line of the patch must be '*** End Patch'".to_string()
        ))
    );
}

#[test]
fn test_parse_patch_environment_id_preamble() {
    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Environment ID: remote\n\
             *** Add File: hello.txt\n\
             +hello\n\
             *** End Patch",
            ParseMode::Strict
        ),
        Ok(ApplyPatchArgs {
            hunks: vec![AddFile {
                path: PathBuf::from("hello.txt"),
                contents: "hello\n".to_string(),
            }],
            patch: "*** Begin Patch\n*** Environment ID: remote\n*** Add File: hello.txt\n+hello\n*** End Patch".to_string(),
            workdir: None,
            environment_id: Some("remote".to_string()),
        })
    );

    assert_eq!(
        parse_patch_text(
            "*** Begin Patch\n\
             *** Environment ID:   \n\
             *** Add File: hello.txt\n\
             +hello\n\
             *** End Patch",
            ParseMode::Strict
        ),
        Err(InvalidPatchError(
            "apply_patch environment_id cannot be empty".to_string()
        ))
    );
}

#[derive(Debug, Arbitrary)]
struct AddLine(#[proptest(regex = "[A-Za-z0-9 _.-]{1,24}")] String);

proptest! {
    #![proptest_config(ProptestConfig::with_cases(16))]

    // Property: a valid add-file patch always produces one matching AddFile hunk.
    #[test]
    fn add_file_patch_preserves_arbitrary_content(input: AddLine) {
        let patch = format!(
            "*** Begin Patch\n*** Add File: generated.txt\n+{}\n*** End Patch",
            input.0
        );
        let parsed = parse_patch(&patch).expect("generated patch should parse");
        assert_eq!(
            parsed.hunks,
            vec![AddFile {
                path: PathBuf::from("generated.txt"),
                contents: format!("{}\n", input.0),
            }]
        );
    }
}
