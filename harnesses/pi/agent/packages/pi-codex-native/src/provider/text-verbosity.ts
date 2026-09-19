import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { codexCompatibility } from "../compatibility.ts";
import { type CodexNativeSettings, getCodexNativeSettings } from "../contributions/xsettings.ts";
import { openAIRequestAdapter } from "../openai-request-adapter.ts";

// type-boundary: Pi exposes provider payloads without a type; isRecord narrows the payload before mutation.
type UntrustedProviderValue = unknown;
type Payload = Record<string, UntrustedProviderValue>;

function isRecord(value: UntrustedProviderValue): value is Payload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eligible(ctx: ExtensionContext): boolean {
	return codexCompatibility(ctx.model)?.features.textVerbosity === true;
}

export function registerTextVerbosity(
	pi: Pick<ExtensionAPI, "on">,
	getSettings: () => CodexNativeSettings = getCodexNativeSettings,
): void {
	pi.on("before_provider_request", (event, ctx) => {
		if (!eligible(ctx) || !isRecord(event.payload)) return undefined;
		return openAIRequestAdapter(ctx.model)?.applyVerbosity(event.payload, getSettings().textVerbosity);
	});
}
