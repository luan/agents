import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type FffNodeModule = typeof import("@ff-labs/fff-node");

interface PackageJson {
	name?: string;
	version?: string;
	optionalDependencies?: Record<string, string>;
}

const RUNTIME_CACHE_VERSION = "v1";
const extensionDir = path.dirname(fileURLToPath(import.meta.url));
let fffNodeModulePromise: Promise<FffNodeModule> | null = null;

function packageSegments(packageName: string): string[] {
	return packageName.split("/");
}

function packageDir(nodeModulesDir: string, packageName: string): string {
	return path.join(nodeModulesDir, ...packageSegments(packageName));
}

function readPackageJson(packageRoot: string): PackageJson {
	return JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as PackageJson;
}

function findSourceNodeModules(): string {
	let dir = extensionDir;
	while (true) {
		const candidate = path.join(dir, "node_modules", "@ff-labs", "fff-node", "package.json");
		if (existsSync(candidate)) return path.join(dir, "node_modules");

		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("Could not find @ff-labs/fff-node in extension node_modules");
}

function runtimeCacheBase(): string {
	return (
		process.env.PI_FFF_RUNTIME_DIR ??
		path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "pi-fff", "runtime")
	);
}

function runtimeKey(fffPackage: PackageJson, ffiPackage: PackageJson): string {
	return [
		`${fffPackage.name ?? "fff-node"}@${fffPackage.version ?? "unknown"}`,
		`${ffiPackage.name ?? "ffi-rs"}@${ffiPackage.version ?? "unknown"}`,
		`${process.platform}-${process.arch}`,
		RUNTIME_CACHE_VERSION,
	]
		.join("_")
		.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function copyPackage(sourceNodeModules: string, targetNodeModules: string, packageName: string): void {
	const source = packageDir(sourceNodeModules, packageName);
	if (!existsSync(path.join(source, "package.json"))) return;

	const target = packageDir(targetNodeModules, packageName);
	mkdirSync(path.dirname(target), { recursive: true });
	cpSync(source, target, {
		recursive: true,
		dereference: false,
		errorOnExist: false,
		force: false,
	});
}

function copyInstalledOptionalDependencies(
	sourceNodeModules: string,
	targetNodeModules: string,
	packageJson: PackageJson,
): void {
	for (const packageName of Object.keys(packageJson.optionalDependencies ?? {})) {
		copyPackage(sourceNodeModules, targetNodeModules, packageName);
	}
}

function ensureSafeFffRuntime(): string {
	const sourceNodeModules = findSourceNodeModules();
	const fffPackage = readPackageJson(packageDir(sourceNodeModules, "@ff-labs/fff-node"));
	const ffiPackage = readPackageJson(packageDir(sourceNodeModules, "ffi-rs"));
	const runtimeRoot = path.join(runtimeCacheBase(), runtimeKey(fffPackage, ffiPackage));
	const markerPath = path.join(runtimeRoot, ".ready.json");

	if (existsSync(markerPath)) return runtimeRoot;

	const tmpRoot = `${runtimeRoot}.tmp-${process.pid}-${Date.now()}`;
	rmSync(tmpRoot, { recursive: true, force: true });
	mkdirSync(path.join(tmpRoot, "node_modules"), { recursive: true });

	try {
		const targetNodeModules = path.join(tmpRoot, "node_modules");
		copyPackage(sourceNodeModules, targetNodeModules, "@ff-labs/fff-node");
		copyPackage(sourceNodeModules, targetNodeModules, "ffi-rs");
		copyInstalledOptionalDependencies(sourceNodeModules, targetNodeModules, fffPackage);
		copyInstalledOptionalDependencies(sourceNodeModules, targetNodeModules, ffiPackage);

		const entry = path.join(targetNodeModules, "@ff-labs", "fff-node", "dist", "src", "index.js");
		if (!existsSync(entry)) throw new Error(`Missing staged @ff-labs/fff-node entrypoint: ${entry}`);

		mkdirSync(path.dirname(runtimeRoot), { recursive: true });
		writeFileSync(
			path.join(tmpRoot, ".ready.json"),
			JSON.stringify(
				{
					fffNode: fffPackage.version,
					ffiRs: ffiPackage.version,
					platform: process.platform,
					arch: process.arch,
					cacheVersion: RUNTIME_CACHE_VERSION,
				},
				null,
				2,
			),
		);
		rmSync(runtimeRoot, { recursive: true, force: true });
		renameSync(tmpRoot, runtimeRoot);
		return runtimeRoot;
	} catch (error) {
		rmSync(tmpRoot, { recursive: true, force: true });
		throw error;
	}
}

export async function loadFffNodeModule(): Promise<FffNodeModule> {
	if (!fffNodeModulePromise) {
		const runtimeRoot = ensureSafeFffRuntime();
		const entry = path.join(runtimeRoot, "node_modules", "@ff-labs", "fff-node", "dist", "src", "index.js");
		fffNodeModulePromise = import(pathToFileURL(entry).href) as Promise<FffNodeModule>;
	}
	return fffNodeModulePromise;
}
