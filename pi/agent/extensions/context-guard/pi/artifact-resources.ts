import {
	formatResourceUri,
	type Resource,
	type ResourceProvider,
	type ResourceRef,
	type SearchHit,
} from "../../shared/resources.ts";
import { invokeCore, parseCoreJson } from "./core.js";
import { getStorePath } from "./tool-paths.js";

type ArtifactResult = {
	artifactId?: unknown;
	captureId?: unknown;
	sourceKind?: unknown;
	label?: unknown;
	timestamp?: unknown;
	source?: unknown;
	chunkIndex?: unknown;
	snippet?: unknown;
};

function artifactId(ref: ResourceRef): string {
	const path = ref.path.replace(/^\/+/, "");
	if (ref.authority === "capture" || ref.authority === "artifact") {
		if (!path) throw new Error(`Artifact URI needs an ID: ${formatResourceUri(ref)}`);
		return path;
	}
	if (path) throw new Error(`Artifact URI cannot have a path: ${formatResourceUri(ref)}`);
	return ref.authority;
}

function artifactResource(ref: ResourceRef, results: readonly ArtifactResult[]): Resource {
	const first = results[0];
	return {
		uri: formatResourceUri(ref),
		name: artifactId(ref),
		title: typeof first?.label === "string" ? first.label : undefined,
		kind: "captured-artifact",
		mediaType: "text/plain",
	};
}

function resultText(result: ArtifactResult): string {
	const snippet = typeof result.snippet === "string" ? result.snippet : "";
	const label = typeof result.label === "string" && result.label ? `[${result.label}]\n` : "";
	return `${label}${snippet}`.trim();
}

export function artifactResourceProvider(baseCwd: string): ResourceProvider {
	return {
		async read(ref, context) {
			const id = artifactId(ref);
			const response = await invokeCore(
				"search",
				{
					dbPath: getStorePath(context?.cwd ?? baseCwd),
					artifactId: id,
					limit: 50,
				},
				context?.signal,
			);
			const data = parseCoreJson<{ results?: ArtifactResult[] }>(response);
			const results = data?.results ?? [];
			if (results.length === 0) throw new Error(`Artifact not found: ${formatResourceUri(ref)}`);
			const content = results.map(resultText).filter(Boolean).join("\n\n");
			return {
				resource: { ...artifactResource(ref, results), size: Buffer.byteLength(content, "utf8") },
				content,
			};
		},
		async search(request): Promise<SearchHit[]> {
			if (request.scope?.scheme !== "artifact") return [];
			const scopeId = artifactId(request.scope);
			const response = await invokeCore(
				"search",
				{
					dbPath: getStorePath(request.context?.cwd ?? baseCwd),
					query: request.query,
					artifactId: scopeId,
					limit: request.limit ?? 50,
				},
				request.context?.signal,
			);
			const data = parseCoreJson<{ results?: ArtifactResult[] }>(response);
			return (data?.results ?? []).map((result) => ({
				...artifactResource(request.scope!, [result]),
				snippet: typeof result.snippet === "string" ? result.snippet : undefined,
				score: 1,
			}));
		},
		async find(ref, context) {
			const result = await this.read(ref, context);
			return [result.resource];
		},
	};
}
