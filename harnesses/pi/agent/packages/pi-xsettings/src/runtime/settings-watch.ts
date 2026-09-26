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
	const watchers: FSWatcher[] = [];
	try {
		for (const [directory, names] of directories) {
			const watcher = watch(directory, { persistent: false }, (event, filename) => {
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
					report(error as Error);
					return;
				}
				if (queued) return;
				queued = setImmediate(() => {
					queued = undefined;
					void refresh().catch((error: Error) => report(error));
				});
			});
			watcher.on("error", report);
			watchers.push(watcher);
		}
	} catch (error) {
		for (const watcher of watchers) watcher.close();
		throw error;
	}
	return () => {
		if (queued) clearImmediate(queued);
		for (const watcher of watchers) watcher.close();
	};
}
