mod host;
mod install;
mod kernel;
mod wire;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    host::run().await
}
