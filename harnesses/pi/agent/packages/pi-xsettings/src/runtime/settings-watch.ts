import { type FSWatcher, realpathSync, statSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";

function fileStamp(path: string): string | undefined {
	try {
		const { dev, ino, mtimeNs, ctimeNs, size } = statSync(path, { bigint: true });
		return `${dev}:${ino}:${mtimeNs}:${ctimeNs}:${size}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** Watch directories so atomic replacement and managed symlink targets stay visible. */
export function watchSettings(
	paths: readonly string[],
	refresh: () => Promise<void>,
	report: (error: Error) => void,
): () => void {
	const directories = new Map<string, Set<string>>();
	for (const path of paths) {
		let target = path;
		try {
			target = realpathSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		for (const candidate of [path, target]) {
			const directory = dirname(candidate);
			const names = directories.get(directory) ?? new Set<string>();
			names.add(basename(candidate));
			directories.set(directory, names);
		}
	}
	const stamps = new Map<string, string | undefined>();
	for (const [directory, names] of directories) {
		for (const name of names) {
			const path = join(directory, name);
			stamps.set(path, fileStamp(path));
		}
	}
	let queued: NodeJS.Immediate | undefined;
	let stopped = false;
	const reportError = (error: Error): void => {
		if (!stopped) report(error);
	};
	const queueRefresh = () => {
		if (stopped || queued) return;
		queued = setImmediate(() => {
			queued = undefined;
			if (!stopped) void refresh().catch(reportError);
		});
	};
	const watchers: FSWatcher[] = [];
	try {
		for (const [directory, names] of directories) {
			const watcher = watch(directory, { persistent: false }, (event, filename) => {
				if (stopped) return;
				try {
					// Bun 1.3 may report only the temp filename for an atomic rename. Check watched files
					// so unrelated renames, including our own lock, do not trigger reconciliation.
					let changed = false;
					for (const name of names) {
						const path = join(directory, name);
						const stamp = fileStamp(path);
						if (stamp !== stamps.get(path)) changed = true;
						stamps.set(path, stamp);
					}
					if (filename !== null && !names.has(filename.toString()) && (event !== "rename" || !changed)) return;
				} catch (error) {
					reportError(error as Error);
					return;
				}
				queueRefresh();
			});
			watcher.on("error", reportError);
			watchers.push(watcher);
		}
	} catch (error) {
		for (const watcher of watchers) watcher.close();
		throw error;
	}
	// Native watchers may miss a replacement during startup. Reconcile once after subscribing.
	queueRefresh();
	return () => {
		stopped = true;
		if (queued) clearImmediate(queued);
		for (const watcher of watchers) watcher.close();
	};
}
