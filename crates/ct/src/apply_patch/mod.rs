mod apply;
mod diff;
mod parser;
pub mod repair;
mod scope;
mod seek_sequence;
pub mod telemetry;
#[cfg(test)]
mod tests;

pub use apply::{ApplyFailure, ApplyOutcome, ApplyPatchError, ChangeType, FileChange, apply};
pub use telemetry::{AnchorAttempt, CallRecord, FileCallEntry, Fingerprint, Telemetry, sha1_hex};

/// Maximum accepted patch body length. Guards against unbounded allocation
/// from `ct apply-patch` stdin.
pub const MAX_PATCH_SIZE_BYTES: usize = 16 * 1024 * 1024;
