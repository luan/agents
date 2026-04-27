mod apply;
mod diff;
pub mod draft;
mod parser;
pub mod repair;
mod seek_sequence;
pub mod telemetry;
#[cfg(test)]
mod tests;

pub use apply::{
    ApplyFailure, ApplyOutcome, ApplyPatchError, ChangeType, FileChange, HunkFuzzy, HunkRegion,
    LineChange, apply,
};
pub use repair::{RepairBlock, failure_kind};
pub use telemetry::{
    AnchorAttempt, CallRecord, FileCallEntry, Fingerprint, Telemetry, enrich, sha1_hex,
};

/// Maximum accepted patch body length. Guards against unbounded allocation
/// from either `ct apply-patch` (stdin) or the MCP handler (JSON body).
pub const MAX_PATCH_SIZE_BYTES: usize = 16 * 1024 * 1024;
