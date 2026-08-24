// Keep the pinned upstream V8 callback and test shapes recognizable.
#![allow(
    clippy::default_trait_access,
    clippy::elidable_lifetime_names,
    clippy::ignored_unit_patterns,
    clippy::manual_let_else,
    clippy::map_unwrap_or,
    clippy::needless_continue,
    clippy::needless_pass_by_value,
    clippy::similar_names,
    clippy::single_match_else,
    clippy::unused_async_trait_impl
)]

mod cell_actor;
mod runtime;
mod service;
mod session_runtime;
mod task_failure;
mod v8_init;

pub(crate) use task_failure::TaskFailureHandler;

pub use code_mode_protocol::*;
pub use service::InProcessCodeModeSession;
pub use service::InProcessCodeModeSessionProvider;
pub use service::NoopCodeModeSessionDelegate;
pub use service::yield_timeout;
pub use v8_init::V8JitMode;
pub use v8_init::initialize_v8;
