use clap::{CommandFactory, Parser};

#[derive(Parser)]
#[command(name = "vlt")]
#[command(about = "Blueprints vault CLI", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Option<vlt::cli::Command>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        None => {
            Cli::command().print_help()?;
            println!();
            Ok(())
        }
        Some(command) => vlt::cli::dispatch(command),
    }
}
