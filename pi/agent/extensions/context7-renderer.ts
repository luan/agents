import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Context7Tool, decorateContext7Tool } from "./context7/presentation";
import { loadPackageExtension } from "./shared/tool-registry.ts";

const PACKAGE_ENTRY = join(getAgentDir(), "npm/node_modules/@dreki-gg/pi-context7/extensions/context7/index.ts");

export default async function context7Renderer(pi: ExtensionAPI): Promise<void> {
	await loadPackageExtension(pi, PACKAGE_ENTRY, (tool) => decorateContext7Tool(tool as Context7Tool));
}
