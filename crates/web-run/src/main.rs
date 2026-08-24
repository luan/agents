#[tokio::main]
async fn main() -> anyhow::Result<()> {
    web_run::run_main().await
}
