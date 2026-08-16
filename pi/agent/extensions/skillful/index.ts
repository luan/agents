import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { approxTokenCount } from "../shared/output-budget";
import {
	formatResourceUri,
	type Resource,
	type ResourceProvider,
	type ResourceRef,
	registerResourceProvider,
	type SearchHit,
} from "../shared/resources.ts";
import { wrapProvider } from "./autocomplete";
import { installEditorHighlight, removeEditorHighlight } from "./editor";
import { registerSkillfulPresentation } from "./presentation";
import {
	buildItems,
	collectSkills,
	extractDollarSkillReferences,
	formatReadSkillContent,
	formatSkillAssetContent,
	loadedDetails,
	resolveSkillAssetPath,
	rewriteSlashSkillReferences,
	SKILLFUL_CUSTOM_TYPE,
	type SkillfulLoadDetails,
	type SkillReference,
	skillBaseDir,
	stripFrontmatter,
} from "./skills";
import { ensureTranscriptHighlight } from "./transcript";

const AUTOCOMPLETE_INSTALLED = Symbol.for("skillful.autocompleteInstalled");

type SkillState = {
	skills: Map<string, SkillReference[]>;
	items: AutocompleteItem[];
};

type SkillLoad = {
	content: string;
	details: SkillfulLoadDetails;
};

// A live `$stack` turn injected the body and the model then spent a cell on `read skill://stack`, a byte-identical
// 377-token second copy; `$ponytail-review` cost another 542. SYSTEM_PROMPT.md.mustache:127 tells it to always read the
// URI, so naming these as already-present is the half of that contradiction skillful owns.
function alreadyInContextNotice(loads: readonly SkillLoad[]): string {
	const names = loads.map((load) => `skill://${load.details.name}`).join(", ");
	const subject = loads.length === 1 ? "document is" : "documents are";
	return `The complete ${subject} below, already in context: ${names}. Do not read ${loads.length === 1 ? "it" : "them"} again this turn.`;
}

async function skillFiles(root: string, directory = root): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = `${directory}/${entry.name}`;
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) files.push(...(await skillFiles(root, path)));
		else files.push(path);
	}
	return files;
}

function skillAssetPath(ref: ResourceRef): string | undefined {
	const path = ref.path.replace(/^\/+|\/+$/g, "");
	return path || undefined;
}
function skillReadAssetPath(ref: ResourceRef): string | undefined {
	const path = skillAssetPath(ref);
	return path === "SKILL.md" ? undefined : path;
}
function isMissingPath(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}
async function safeSkillFilePath(root: string, filePath: string): Promise<string | undefined> {
	const [realRoot, realFile] = await Promise.all([realpath(root), realpath(filePath)]);
	const fromRoot = relative(realRoot, realFile);
	if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return undefined;
	return realFile;
}

async function readSkillAsset(root: string, filePath: string): Promise<string> {
	const safePath = await safeSkillFilePath(root, filePath);
	if (!safePath) throw new Error(`Skill asset path must stay under ${root}: ${filePath}`);
	return readFile(safePath, "utf8");
}

async function resourceFromSkillFile(uri: string, name: string, filePath: string): Promise<Resource> {
	const metadata = await stat(filePath);
	return {
		uri,
		name,
		kind: "skill",
		mediaType: "text/markdown",
		size: metadata.size,
		modifiedAt: metadata.mtime.toISOString(),
	};
}
function mergeSkillResources(current: Resource, next: Resource): Resource {
	const modifiedAt = [current.modifiedAt, next.modifiedAt]
		.filter((value): value is string => Boolean(value))
		.sort()
		.at(-1);
	return {
		...next,
		size: (current.size ?? 0) + (next.size ?? 0) + Buffer.byteLength("\n\n"),
		...(modifiedAt ? { modifiedAt } : {}),
	};
}

export default function (pi: ExtensionAPI) {
	const state: SkillState = { skills: new Map(), items: [] };
	const refresh = () => {
		state.skills = collectSkills(pi);
		state.items = buildItems(state.skills);
	};
	const skillNames = () => new Set(state.skills.keys());
	const currentItems = () => {
		refresh();
		return state.items;
	};

	const readSkill = async (name: string, filePath: string, assetPath?: string): Promise<SkillLoad> => {
		if (assetPath !== undefined) {
			const resolvedPath = resolveSkillAssetPath(filePath, assetPath);
			const content = formatSkillAssetContent(
				name,
				assetPath,
				resolvedPath,
				await readSkillAsset(skillBaseDir(filePath), resolvedPath),
			);
			return {
				content,
				details: loadedDetails(name, "read", resolvedPath, skillBaseDir(filePath), approxTokenCount(content)),
			};
		}
		const body = rewriteSlashSkillReferences(stripFrontmatter(await readFile(filePath, "utf8")), state.skills.keys());
		const content = formatReadSkillContent(name, filePath, body);
		const details = loadedDetails(name, "read", filePath, skillBaseDir(filePath), approxTokenCount(content));
		return {
			content,
			details,
		};
	};
	const readableReferences = async (references: SkillReference[], assetPath?: string): Promise<SkillReference[]> => {
		if (assetPath === undefined) return references;
		const readable: SkillReference[] = [];
		for (const reference of references) {
			const resolvedPath = resolveSkillAssetPath(reference.filePath, assetPath);
			try {
				if ((await stat(resolvedPath)).isFile()) readable.push(reference);
			} catch (error) {
				if (!isMissingPath(error)) throw error;
			}
		}
		return readable;
	};
	const loadSkill = async (name: string, assetPath?: string): Promise<SkillLoad> => {
		refresh();
		const references = state.skills.get(name);
		if (!references) throw new Error(`Unknown skill "${name}"`);
		if (references.length === 0) {
			throw new Error(`Plugin "${name}" has no local skill document; use its enabled app tools directly`);
		}
		const readable = await readableReferences(references, assetPath);
		if (readable.length === 0) throw new Error(`Skill asset "${assetPath}" not found in "${name}"`);
		const loads = await Promise.all(
			readable.map((reference) => readSkill(reference.name, reference.filePath, assetPath)),
		);
		const [firstLoad] = loads;
		if (!firstLoad) throw new Error(`Unknown skill "${name}"`);
		if (loads.length === 1) return firstLoad;
		return {
			content: loads.map((load) => load.content).join("\n\n"),
			details: {
				extension: "skillful",
				kind: "skill-load",
				name,
				status: "read",
				tokens: loads.reduce((total, load) => total + (load.details.tokens ?? 0), 0),
				loads: loads.map((load) => load.details),
			},
		};
	};
	const resourceProvider: ResourceProvider = {
		async read(ref) {
			const assetPath = skillReadAssetPath(ref);
			const load = await loadSkill(ref.authority, assetPath);
			const sourcePath = load.details.filePath;
			return {
				resource: {
					uri: formatResourceUri(ref),
					name: assetPath ?? "SKILL.md",
					kind: "skill",
					mediaType: "text/markdown",
					...(sourcePath ? { path: sourcePath } : {}),
					size: Buffer.byteLength(load.content, "utf8"),
					metadata: {
						skillName: ref.authority,
						assetPath: assetPath ?? "SKILL.md",
						tokens: load.details.tokens ?? 0,
						...(sourcePath ? { sourcePath } : {}),
					},
				},
				content: load.content,
			};
		},
		async search(request): Promise<SearchHit[]> {
			refresh();
			const query = request.query.trim().toLowerCase();
			if (!query) return [];
			const names = request.scope?.scheme === "skill" ? [request.scope.authority] : [...state.skills.keys()];
			const hits: SearchHit[] = [];
			for (const name of names) {
				const assetPath =
					request.scope?.scheme === "skill" && request.scope.authority === name
						? skillReadAssetPath(request.scope)
						: undefined;
				try {
					const load = await loadSkill(name, assetPath);
					const index = load.content.toLowerCase().indexOf(query);
					if (index === -1) continue;
					const ref = {
						scheme: "skill" as const,
						authority: name,
						path: assetPath ? `/${assetPath}` : "",
						query: {},
					};
					hits.push({
						uri: formatResourceUri(ref),
						name: assetPath ?? "SKILL.md",
						kind: "skill",
						mediaType: "text/markdown",
						snippet: load.content.slice(Math.max(0, index - 80), index + query.length + 160),
						score: 1,
					});
				} catch {
					// Discovery can race resource refresh. Omit stale skills from search.
				}
			}
			return hits;
		},
		async find(ref) {
			refresh();
			const references = state.skills.get(ref.authority);
			if (!references) throw new Error(`Unknown skill "${ref.authority}"`);
			const requested = skillAssetPath(ref);
			const resources = new Map<string, Resource>();
			for (const reference of references) {
				const root = skillBaseDir(reference.filePath);
				const searchRoot = requested ? resolveSkillAssetPath(reference.filePath, requested) : root;
				let metadata: Awaited<ReturnType<typeof stat>>;
				try {
					metadata = await stat(searchRoot);
				} catch (error) {
					if (isMissingPath(error)) continue;
					throw error;
				}
				if (requested) {
					try {
						if (!(await safeSkillFilePath(root, searchRoot))) continue;
					} catch (error) {
						if (isMissingPath(error)) continue;
						throw error;
					}
				}
				const filePaths = metadata.isDirectory()
					? await skillFiles(root, searchRoot)
					: metadata.isFile()
						? [searchRoot]
						: [];
				for (const filePath of filePaths) {
					let safePath: string | undefined;
					try {
						safePath = await safeSkillFilePath(root, filePath);
					} catch (error) {
						if (isMissingPath(error)) continue;
						throw error;
					}
					if (!safePath) continue;
					const relativePath = relative(root, filePath).replaceAll("\\", "/");
					const uri = formatResourceUri({
						scheme: "skill",
						authority: ref.authority,
						path: relativePath === "SKILL.md" ? "" : `/${relativePath}`,
						query: {},
					});
					const resource = await resourceFromSkillFile(uri, relativePath, safePath);
					const current = resources.get(uri);
					resources.set(uri, current ? mergeSkillResources(current, resource) : resource);
				}
			}
			return [...resources.values()];
		},
	};

	registerResourceProvider("skill", resourceProvider);
	pi.on("resources_discover", () => {
		refresh();
	});

	registerSkillfulPresentation(pi);

	pi.on("before_agent_start", async (event, _ctx) => {
		refresh();
		ensureTranscriptHighlight(skillNames);

		const referenced = extractDollarSkillReferences(event.prompt, state.skills.keys());
		if (referenced.length === 0) return;

		const loads: SkillLoad[] = [];
		for (const name of referenced) {
			try {
				loads.push(await loadSkill(name));
			} catch (error) {
				if (!(error instanceof Error) || !error.message.includes("has no local skill document")) throw error;
			}
		}
		const [firstLoad] = loads;
		if (!firstLoad) return;
		const details =
			loads.length === 1
				? firstLoad.details
				: {
						...firstLoad.details,
						loads: loads.map((load) => load.details),
					};
		return {
			message: {
				customType: SKILLFUL_CUSTOM_TYPE,
				content: [alreadyInContextNotice(loads), ...loads.map((load) => load.content)].join("\n\n"),
				display: true,
				details,
			},
		};
	});

	pi.on("session_start", async (event, ctx) => {
		refresh();
		setTimeout(() => {
			try {
				refresh();
				ensureTranscriptHighlight(skillNames);
				if (ctx.hasUI) installEditorHighlight(ctx.ui, skillNames);
			} catch (error) {
				if (!(error instanceof Error) || !error.message.includes("ctx is stale")) throw error;
			}
		}, 0);
		if (!ctx.hasUI) return;
		const ui = ctx.ui as typeof ctx.ui & { [AUTOCOMPLETE_INSTALLED]?: true };
		if (ui[AUTOCOMPLETE_INSTALLED] && event.reason !== "reload") return;
		ui[AUTOCOMPLETE_INSTALLED] = true;
		ctx.ui.addAutocompleteProvider((current) => wrapProvider(current, currentItems));
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) removeEditorHighlight(ctx.ui);
	});
}
