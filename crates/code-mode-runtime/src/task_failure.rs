pub(crate) type TaskFailureHandler = std::sync::Arc<dyn Fn(String) + Send + Sync>;
