use std::process::Command;

fn main() {
    let Some(home) = dirs::home_dir() else {
        eprintln!("cannot determine home directory");
        std::process::exit(127);
    };
    let target = home
        .join(".opencode")
        .join("bin")
        .join(format!("opencode{}", std::env::consts::EXE_SUFFIX));
    if !target.is_file() {
        eprintln!("opencode binary not found at {}", target.display());
        std::process::exit(127);
    }

    let mut command = Command::new(target);
    command
        .args(std::env::args_os().skip(1))
        .env("OPENCODE_DISABLE_CLAUDE_CODE", "1");

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = command.exec();
        eprintln!("failed to launch opencode: {err}");
        std::process::exit(127);
    }

    #[cfg(not(unix))]
    {
        match command.status() {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(err) => {
                eprintln!("failed to launch opencode: {err}");
                std::process::exit(127);
            }
        }
    }
}
