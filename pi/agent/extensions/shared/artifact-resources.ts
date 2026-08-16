// `artifact://` is the read side of the spill that tool bounding creates. Identity comes from `ResourceContext`, paths are contained by `resolveResourcePath`.
// Unlike `local://`, which is scratch in tmpdir, artifacts sit beside the session file so a reference in a resumed transcript still resolves.

import { type ArtifactSession, type ArtifactStore, artifactStoreFor, type ResolvedArtifact } from "./artifact-store.ts";
import {
	formatResourceUri,
	type Resource,
	type ResourceContext,
	type ResourceProvider,
	type ResourceRef,
	type SearchHit,
} from "./resources.ts";

const SNIPPET_MAX_CHARS = 400;

function artifactId(ref: ResourceRef): string {
	const path = ref.path.replace(/^\/+/, "");
	if (ref.authority === "capture" || ref.authority === "artifact") {
		if (!path) throw new Error(`Artifact URI needs an ID: ${formatResourceUri(ref)}`);
		return path;
	}
	if (path) throw new Error(`Artifact URI cannot have a path: ${formatResourceUri(ref)}`);
	return ref.authority;
}

function artifactResource(ref: ResourceRef, artifact: ResolvedArtifact): Resource {
	return {
		uri: formatResourceUri(ref),
		name: artifact.id,
		title: artifact.toolType,
		kind: "captured-artifact",
		mediaType: "text/plain",
		size: artifact.size,
		path: artifact.path,
	};
}

function matcher(query: string, literal: boolean, ignoreCase: boolean): (line: string) => boolean {
	if (literal) {
		const needle = ignoreCase ? query.toLowerCase() : query;
		return (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const pattern = new RegExp(query, ignoreCase ? "i" : "");
	return (line) => pattern.test(line);
}

export function createArtifactResourceProvider(currentSession: () => ArtifactSession): ResourceProvider {
	const storeFor = (context: ResourceContext | undefined): ArtifactStore => {
		const session = currentSession();
		return artifactStoreFor({
			sessionFile: context?.sessionFile ?? session.sessionFile,
			sessionId: context?.sessionId ?? session.sessionId,
		});
	};

	const resolve = async (ref: ResourceRef, context: ResourceContext | undefined) => {
		const store = storeFor(context);
		const id = artifactId(ref);
		const artifact = await store.resolve(id);
		if (!artifact) {
			const available = await store.listIds();
			throw new Error(
				`Artifact not found: ${formatResourceUri(ref)}. Available: ${available.length > 0 ? available.join(", ") : "none"}`,
			);
		}
		return { store, artifact };
	};

	return {
		async read(ref, context) {
			const { store, artifact } = await resolve(ref, context);
			return { resource: artifactResource(ref, artifact), content: await store.read(artifact) };
		},

		/** Grep one artifact. `search <pattern> artifact://12` lands here because fileops routes a resource URI in the search path. An unscoped search returns nothing. */
		async search(request): Promise<SearchHit[]> {
			if (request.scope?.scheme !== "artifact") return [];
			const scope = request.scope;
			const { store, artifact } = await resolve(scope, request.context);
			const matches = matcher(request.query, request.literal ?? false, request.ignoreCase ?? false);
			const content = await store.read(artifact);
			const limit = request.limit ?? 50;
			const hits: SearchHit[] = [];
			let line = 0;
			for (const text of content.split("\n")) {
				line++;
				if (!matches(text)) continue;
				hits.push({
					...artifactResource(scope, artifact),
					name: `${artifact.id}:${line}`,
					snippet: `${line}: ${text.slice(0, SNIPPET_MAX_CHARS)}`,
					score: 1,
				});
				if (hits.length >= limit) break;
			}
			return hits;
		},

		async find(ref, context) {
			const { artifact } = await resolve(ref, context);
			return [artifactResource(ref, artifact)];
		},
	};
}
