import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSettings } from "../src/sdk.ts";
import { ensureXSettingsRegistry } from "../src/protocol/settings.ts";
import { publishAllSettings } from "../src/runtime/settings.ts";
import {
	publishSessionSettings,
	sessionSettingsDocument,
	sessionSettingRecord,
	SESSION_SETTING_ENTRY,
} from "../src/runtime/session-settings.ts";

test("session settings follow branches, isolate sessions, and leave global configuration untouched", async () => {
	const settings = createSettings({
		namespace: "session-test",
		label: "Session test",
		definitions: {
			mode: {
				type: "string",
				default: "normal",
				scope: "session",
				category: "behavior",
				label: "Mode",
				description: "This session",
			},
			global: { type: "boolean", default: false, category: "behavior", label: "Global", description: "Global" },
		},
	});
	const dispose = settings.register();
	const registry = ensureXSettingsRegistry();
	const first = SessionManager.inMemory(),
		second = SessionManager.inMemory();
	const document = { behavior: { "session-test": { global: true, mode: "obsolete-global-mode" } } };
	const snapshot = structuredClone(document);
	const path = ["behavior", "session-test", "mode"];
	const branch = first.appendCustomEntry("marker", {});
	first.appendCustomEntry(SESSION_SETTING_ENTRY, sessionSettingRecord({ path, value: "persistent" }));
	try {
		await publishAllSettings(registry, document);
		publishSessionSettings(
			registry,
			first.getSessionId(),
			sessionSettingsDocument(registry, document, first.getBranch()),
		);
		publishSessionSettings(
			registry,
			second.getSessionId(),
			sessionSettingsDocument(registry, document, second.getBranch()),
		);
		expect(settings.get(first.getSessionId())).toEqual({ mode: "persistent", global: true });
		expect(settings.get(second.getSessionId())).toEqual({ mode: "normal", global: true });
		expect(settings.get()).toEqual({ mode: "normal", global: true });
		first.appendCustomEntry(SESSION_SETTING_ENTRY, sessionSettingRecord({ path, value: undefined }));
		publishSessionSettings(
			registry,
			first.getSessionId(),
			sessionSettingsDocument(registry, document, first.getBranch()),
		);
		expect(settings.get(first.getSessionId()).mode).toBe("normal");
		first.branch(branch);
		publishSessionSettings(
			registry,
			first.getSessionId(),
			sessionSettingsDocument(registry, document, first.getBranch()),
		);
		expect(settings.get(first.getSessionId()).mode).toBe("normal");
		expect(document).toEqual(snapshot);
	} finally {
		dispose();
	}
});
