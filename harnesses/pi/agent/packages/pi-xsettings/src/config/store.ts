import { realpathSync } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type * as SmolToml from "smol-toml";
import type { SettingValue } from "../protocol/settings.ts";

// Managed package files are symlinks. Resolve dependencies from the real package
// path so the extension uses its declared install instead of Pi's global modules.
const { parse, stringify } = createRequire(realpathSync(fileURLToPath(import.meta.url)))(
	"smol-toml",
) as typeof SmolToml;

export type SettingsRecord = SmolToml.TomlTableWithoutBigInt;
export type StoredSettingValue = SmolToml.TomlValueWithoutBigInt;

const CATEGORIES = ["appearance", "behavior", "interaction", "tools"] as const;

function isRecord(value: StoredSettingValue): value is SettingsRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tomlKey(segment: string): string {
	return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

function tomlValue(value: StoredSettingValue): string {
	const encoded = stringify({ value }).trimEnd();
	const prefix = "value = ";
	if (!encoded.startsWith(prefix) || encoded.slice(prefix.length).includes("\n")) {
		throw new Error("xsettings values must fit in one TOML assignment");
	}
	return encoded.slice(prefix.length);
}

function isArrayOfTables(value: StoredSettingValue): value is SettingsRecord[] {
	return Array.isArray(value) && value.length > 0 && value.every((entry) => isRecord(entry));
}

interface TableContents {
	assignments: string[];
	arrayTables: string[];
}

function tableContents(
	record: SettingsRecord,
	assignmentPrefix: readonly string[],
	headerPrefix: readonly string[],
): TableContents {
	const assignments: string[] = [];
	const arrayTables: string[] = [];
	for (const [key, value] of Object.entries(record)) {
		const assignmentPath = [...assignmentPrefix, key];
		const headerPath = [...headerPrefix, key];
		if (isRecord(value)) {
			if (Object.keys(value).length === 0) {
				arrayTables.push(`[${headerPath.map(tomlKey).join(".")}]`);
				continue;
			}
			const nested = tableContents(value, assignmentPath, headerPath);
			assignments.push(...nested.assignments);
			arrayTables.push(...nested.arrayTables);
		} else if (isArrayOfTables(value)) {
			for (const entry of value) arrayTables.push(...serializeArrayTable(headerPath, entry));
		} else assignments.push(`${assignmentPath.map(tomlKey).join(".")} = ${tomlValue(value)}`);
	}
	return { assignments, arrayTables };
}

function serializeArrayTable(path: readonly string[], record: SettingsRecord): string[] {
	const contents = tableContents(record, [], path);
	const header = `[[${path.map(tomlKey).join(".")}]]`;
	const table = contents.assignments.length > 0 ? `${header}\n${contents.assignments.join("\n")}` : header;
	return [table, ...contents.arrayTables];
}

export function stringifyXSettings(document: SettingsRecord): string {
	const remainder = { ...document };
	const sections: string[] = [];
	for (const category of CATEGORIES) {
		const value = remainder[category];
		delete remainder[category];
		if (value === undefined) continue;
		if (!isRecord(value)) throw new Error(`[${category}] must be a TOML table`);
		const contents = tableContents(value, [], [category]);
		if (contents.assignments.length > 0) sections.push(`[${category}]\n${contents.assignments.join("\n")}`);
		sections.push(...contents.arrayTables);
	}
	const extraTables = stringify(remainder).trim();
	if (extraTables) sections.push(extraTables);
	return `${sections.join("\n\n")}\n`;
}

export function xsettingsPath(agentDir = getAgentDir()): string {
	return join(agentDir, "xsettings.toml");
}

export class XSettingsStore {
	private writeTail = Promise.resolve();

	constructor(readonly path = xsettingsPath()) {}

	async load(): Promise<SettingsRecord> {
		try {
			return parse(await readFile(this.path, "utf8"), { integersAsBigInt: false }) as SmolToml.TomlTableWithoutBigInt;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await mkdir(dirname(this.path), { recursive: true });
			await writeFile(this.path, "# Shared Pi and extension settings.\n", { flag: "wx" }).catch((writeError) => {
				if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
			});
			return {};
		}
	}

	async set(path: readonly string[], value: SettingValue): Promise<SettingsRecord> {
		let result: SettingsRecord = {};
		this.writeTail = this.writeTail.then(async () => {
			const document = await this.load();
			setPath(document, path, value);
			await this.write(document);
			result = document;
		});
		await this.writeTail;
		return result;
	}

	async unset(path: readonly string[]): Promise<SettingsRecord> {
		let result: SettingsRecord = {};
		this.writeTail = this.writeTail.then(async () => {
			const document = await this.load();
			deletePath(document, path);
			await this.write(document);
			result = document;
		});
		await this.writeTail;
		return result;
	}

	private async write(document: SettingsRecord): Promise<void> {
		let target = this.path;
		try {
			target = await realpath(this.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await mkdir(dirname(target), { recursive: true });
		let mode = 0o600;
		try {
			mode = (await stat(target)).mode & 0o777;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(temporary, stringifyXSettings(document), { mode });
		await rename(temporary, target);
	}
}

export function getPath(document: SettingsRecord, path: readonly string[]): StoredSettingValue | undefined {
	let current: StoredSettingValue = document;
	for (const segment of path) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

export function setPath(document: SettingsRecord, path: readonly string[], value: StoredSettingValue): void {
	if (path.length === 0) return;
	let current = document;
	for (const segment of path.slice(0, -1)) {
		const child = current[segment];
		if (isRecord(child)) current = child;
		else {
			const replacement: SettingsRecord = {};
			current[segment] = replacement;
			current = replacement;
		}
	}
	current[path.at(-1)!] = value;
}

export function deletePath(document: SettingsRecord, path: readonly string[]): void {
	if (path.length === 0) return;
	const parents: Array<[SettingsRecord, string]> = [];
	let current = document;
	for (const segment of path.slice(0, -1)) {
		const child = current[segment];
		if (!isRecord(child)) return;
		parents.push([current, segment]);
		current = child;
	}
	delete current[path.at(-1)!];
	for (const [parent, key] of parents.reverse()) {
		const child = parent[key];
		if (isRecord(child) && Object.keys(child).length === 0) delete parent[key];
		else break;
	}
}
