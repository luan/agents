use std::path::Path;

use anyhow::Result;

use crate::pathfilters::{include_path, widen_path_filter_limit};
use crate::resolve;
use crate::store::{ImplementorResult, Store};

#[derive(Debug, Default, Clone)]
pub struct FindImplOptions<'a> {
    pub lang: Option<&'a str>,
    pub limit: usize,
    pub includes: &'a [String],
    pub excludes: &'a [String],
    pub resolved_only: bool,
    pub unresolved_only: bool,
}

pub fn find_implementors(
    cwd: &Path,
    name: &str,
    options: &FindImplOptions<'_>,
) -> Result<Vec<ImplementorResult>> {
    let fetch_limit = widen_path_filter_limit(
        options.limit,
        !options.includes.is_empty()
            || !options.excludes.is_empty()
            || options.lang.is_some()
            || options.resolved_only
            || options.unresolved_only,
    );
    let store = open_store(cwd)?;
    let mut results = store.find_implementors(name, fetch_limit.max(1))?;
    filter_results(&mut results, options);
    Ok(results)
}

pub fn find_implements(
    cwd: &Path,
    name: &str,
    options: &FindImplOptions<'_>,
) -> Result<Vec<ImplementorResult>> {
    let fetch_limit = widen_path_filter_limit(
        options.limit,
        !options.includes.is_empty()
            || !options.excludes.is_empty()
            || options.lang.is_some()
            || options.resolved_only
            || options.unresolved_only,
    );
    let store = open_store(cwd)?;
    let mut results = store.find_implements(name, fetch_limit.max(1))?;
    filter_results(&mut results, options);
    Ok(results)
}

fn filter_results(results: &mut Vec<ImplementorResult>, options: &FindImplOptions<'_>) {
    results.retain(|result| {
        include_path(
            Path::new(&result.rel_path),
            options.includes,
            options.excludes,
        )
    });
    if let Some(lang) = options.lang {
        results.retain(|result| result.language == lang);
    }
    if options.resolved_only {
        results.retain(|result| result.resolved);
    }
    if options.unresolved_only {
        results.retain(|result| !result.resolved);
    }
    if options.limit > 0 && results.len() > options.limit {
        results.truncate(options.limit);
    }
}

fn open_store(cwd: &Path) -> Result<Store> {
    resolve::open_store(cwd)
}
