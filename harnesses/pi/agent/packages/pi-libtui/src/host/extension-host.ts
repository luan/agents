import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { subscribeTuiAppearance } from "../appearance.ts";
import { renderEditorPasteMarkerPills } from "../decoration/editor-pills.ts";
import { ensureEditorRegistry } from "../editor.ts";
import { ensureMouseRegistry } from "../mouse.ts";
import { terminalColorsRegistry, measureTerminalColors } from "../terminal-colors.ts";
import { installCursorBridge } from "./cursor-bridge.ts";
import { installEditorBridge } from "./editor-bridge.ts";
import { installMouseBridge } from "./mouse-bridge.ts";

const WIDGET_KEY = "pi-libtui.mouse-bridge";
const HOST_CAPABILITY_KEY = Symbol.for("pi-libtui/extension-host/v1");
const HOST_PROTOCOL = "pi-libtui/extension-host/v1" as const;

class LibtuiHostWidget implements Component {
	private mode: TUI["mode"];
	private removeMouseBridge: () => void;
	private removeCursorBridge: () => void;
	private readonly removeAppearanceSubscription: () => void;
	private readonly removeColorSubscription: () => void;
	private terminalColorsReady = false;
	private fallbackTheme: Theme | undefined;
	private disposed = false;

	constructor(
		private readonly tui: TUI,
		private readonly ui: ExtensionContext["ui"],
	) {
		this.mode = tui.mode;
		this.removeMouseBridge = installMouseBridge(tui, ensureMouseRegistry());
		this.removeCursorBridge = installCursorBridge(tui);
		this.removeAppearanceSubscription = subscribeTuiAppearance(() => tui.requestRender());
		this.removeColorSubscription = terminalColorsRegistry().subscribe(() => tui.requestRender());
		void this.loadTerminalColors();
	}

	render(): string[] {
		if (this.tui.mode !== this.mode) {
			this.removeMouseBridge();
			this.removeCursorBridge();
			this.mode = this.tui.mode;
			this.removeMouseBridge = installMouseBridge(this.tui, ensureMouseRegistry());
			this.removeCursorBridge = installCursorBridge(this.tui);
		}
		this.applyHarmoniousFallback();
		return [];
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
		this.removeMouseBridge();
		this.removeCursorBridge();
		this.removeAppearanceSubscription();
		this.removeColorSubscription();
	}

	private async loadTerminalColors(): Promise<void> {
		let profile: Awaited<ReturnType<typeof measureTerminalColors>>;
		try {
			profile = await measureTerminalColors(this.tui);
		} catch {
			profile = { scheme: "dark", indexedPalette: "unknown" };
		}
		if (this.disposed) return;
		terminalColorsRegistry().publish(profile);
		this.terminalColorsReady = true;
		this.fallbackTheme = this.ui.getTheme(profile.scheme);
		this.applyHarmoniousFallback();
	}

	private applyHarmoniousFallback(): void {
		if (!this.terminalColorsReady || this.ui.theme.name !== "harmonious") return;
		const terminal = terminalColorsRegistry().current();
		if (terminal?.indexedPalette === "generated" || terminal?.ansiBase16) return;
		if (this.fallbackTheme) this.ui.setTheme(this.fallbackTheme);
	}
}

interface HostRegistration {
	readonly protocol: typeof HOST_PROTOCOL;
	start(ctx: ExtensionContext): void;
	shutdown(ctx: ExtensionContext): void;
}

interface HostCapability {
	readonly protocol: typeof HOST_PROTOCOL;
	readonly version: 1;
	get(key: object): HostRegistration | undefined;
	set(key: object, registration: HostRegistration): void;
	delete(key: object): void;
}

// type-boundary: Symbol.for capabilities can be populated by another extension realm; this validator narrows the host registry methods.
type UntrustedHostValue = unknown;

function isHostCapability(value: UntrustedHostValue): value is HostCapability {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<HostCapability>;
	return (
		candidate.protocol === HOST_PROTOCOL &&
		candidate.version === 1 &&
		typeof candidate.get === "function" &&
		typeof candidate.set === "function" &&
		typeof candidate.delete === "function"
	);
}

function ensureHostCapability(scope: typeof globalThis = globalThis): HostCapability {
	const slots = scope as Record<PropertyKey, UntrustedHostValue>;
	const existing = slots[HOST_CAPABILITY_KEY];
	if (isHostCapability(existing)) return existing;

	const hosts = new WeakMap<object, HostRegistration>();
	const capability: HostCapability = {
		protocol: HOST_PROTOCOL,
		version: 1,
		get: (key) => hosts.get(key),
		set: (key, registration) => hosts.set(key, registration),
		delete: (key) => hosts.delete(key),
	};
	slots[HOST_CAPABILITY_KEY] = capability;
	return capability;
}

function hostIdentity(pi: ExtensionAPI): object {
	const events = pi.events;
	return events && typeof events === "object" ? events : (pi as object);
}

function createHostRegistration(): HostRegistration {
	const editorRegistry = ensureEditorRegistry();
	let activeSession:
		| {
				readonly ui: ExtensionContext["ui"];
				readonly removeEditorBridge: () => void;
				readonly removeEditorDecorator: () => void;
		  }
		| undefined;

	function clearSession(): void {
		const session = activeSession;
		if (!session) return;
		activeSession = undefined;
		session.removeEditorDecorator();
		session.removeEditorBridge();
		session.ui.setWidget(WIDGET_KEY, undefined);
	}

	return {
		protocol: HOST_PROTOCOL,
		start(ctx) {
			if (ctx.mode !== "tui") return;
			clearSession();
			const removeEditorBridge = installEditorBridge(editorRegistry);
			const removeEditorDecorator = editorRegistry.registerRenderDecorator({
				id: "pi-libtui.native-paste-markers",
				decorate: (lines, width) => renderEditorPasteMarkerPills(lines, width, ctx.ui.theme).lines,
			});
			activeSession = { ui: ctx.ui, removeEditorBridge, removeEditorDecorator };
			// A zero-height widget obtains Pi's stable TUI reference without changing the existing spacer row.
			ctx.ui.setWidget(WIDGET_KEY, (tui) => new LibtuiHostWidget(tui, ctx.ui));
		},
		shutdown(ctx) {
			if (ctx.mode !== "tui") return;
			clearSession();
		},
	};
}

export interface LibtuiExtensionHost {
	start(ctx: ExtensionContext): void;
	shutdown(ctx: ExtensionContext): void;
	release(): void;
}

/** Claim the generic host once for all installed copies of pi-libtui. */
export function claimLibtuiExtensionHost(pi: ExtensionAPI): LibtuiExtensionHost | undefined {
	const capability = ensureHostCapability();
	const key = hostIdentity(pi);
	if (capability.get(key)) return undefined;

	const registration = createHostRegistration();
	capability.set(key, registration);
	return {
		start: (ctx) => registration.start(ctx),
		shutdown: (ctx) => registration.shutdown(ctx),
		release() {
			if (capability.get(key) === registration) capability.delete(key);
		},
	};
}
