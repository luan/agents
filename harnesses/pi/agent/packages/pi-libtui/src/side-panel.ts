import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import type { SplitPaneHost, TuiIconName } from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";

export const SIDE_PANEL_REGISTRY_KEY = Symbol.for("pi-side-panel/registry/v1");
export const SIDE_PANEL_PROTOCOL = "pi-side-panel/registry/v1" as const;

export type SidePanelContent = Component &
	Partial<Focusable> & {
		defersInputRender?(data: string): boolean;
		dispose?(): void;
		onMouse?(event: TuiMouseEvent): boolean;
	};

export interface SidePanelHeaderAction {
	readonly label: string;
	readonly actionId: string;
}

export interface SidePanelTab {
	readonly id: string;
	readonly label: string;
	readonly icon?: TuiIconName | { readonly glyph: string };
	readonly headerAction?: SidePanelHeaderAction;
	readonly inputActions?: readonly string[];
	create(host: SplitPaneHost, theme: Theme): SidePanelContent;
	onClose?(): void;
}

export interface SidePanelEmptyAction {
	readonly id: string;
	readonly label: string;
	readonly actionId: string;
}

export interface SidePanelSession {
	readonly protocol: typeof SIDE_PANEL_PROTOCOL;
	readonly version: 1;
	addTab(tab: SidePanelTab, options?: { activate?: boolean; focus?: boolean }): void;
	restoreTab(tab: SidePanelTab): void;
	updateTab(tab: SidePanelTab): void;
	removeTab(id: string): void;
	activate(id: string): void;
	activeTabId(): string | undefined;
	registerEmptyAction(action: SidePanelEmptyAction): () => void;
	show(options?: { focus?: boolean }): void;
	toggle(): void;
	toggleZoom(): void;
	focus(): void;
	focusMain(): void;
	focusNext(): void;
	activatePrevious(): void;
	activateNext(): void;
	isVisible(): boolean;
	isZoomed(): boolean;
	requestRender(): void;
}

export interface SidePanelProvider {
	readonly id: string;
	/** Identity of the Pi session that owns this contribution. */
	readonly session: object;
	attach(panel: SidePanelSession): undefined | (() => void);
}

export interface SidePanelRegistry {
	readonly protocol: typeof SIDE_PANEL_PROTOCOL;
	readonly version: 1;
	register(provider: SidePanelProvider): () => void;
	providers(): readonly SidePanelProvider[];
	installHost(): SidePanelHost;
	hasHost(): boolean;
}

export interface SidePanelHost {
	attach(
		session: object,
		panel: SidePanelSession,
		onError: (provider: SidePanelProvider, error: unknown) => void,
	): () => void;
	dispose(): void;
}

interface RegistryState {
	readonly providers: Map<string, SidePanelProvider>;
	host?: HostState;
}

interface HostState {
	readonly identity: object;
	session?: object;
	panel?: SidePanelSession;
	onError?: (provider: SidePanelProvider, error: unknown) => void;
	readonly attachments: Map<string, { readonly provider: SidePanelProvider; readonly dispose?: () => void }>;
}

const state = new WeakMap<SidePanelRegistry, RegistryState>();
type UntrustedRegistry = unknown;

function isRegistry(value: UntrustedRegistry): value is SidePanelRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SidePanelRegistry>;
	return (
		candidate.protocol === SIDE_PANEL_PROTOCOL &&
		candidate.version === 1 &&
		typeof candidate.register === "function" &&
		typeof candidate.providers === "function" &&
		typeof candidate.installHost === "function" &&
		typeof candidate.hasHost === "function"
	);
}

function registryState(registry: SidePanelRegistry): RegistryState {
	const existing = state.get(registry);
	if (existing) return existing;
	const created = {
		providers: new Map<string, SidePanelProvider>(),
	};
	state.set(registry, created);
	return created;
}

function releaseAttachment(host: HostState, id: string): void {
	const attachment = host.attachments.get(id);
	if (!attachment) return;
	host.attachments.delete(id);
	try {
		attachment.dispose?.();
	} catch {
		// Optional providers cannot block the host lifecycle.
	}
}

function attachProvider(host: HostState, provider: SidePanelProvider): void {
	if (!host.panel || provider.session !== host.session) return;
	if (host.attachments.get(provider.id)?.provider === provider) return;
	releaseAttachment(host, provider.id);
	try {
		host.attachments.set(provider.id, { provider, dispose: provider.attach(host.panel) });
	} catch (error) {
		host.onError?.(provider, error);
	}
}

function detachSession(host: HostState): void {
	for (const id of [...host.attachments.keys()]) releaseAttachment(host, id);
	host.session = undefined;
	host.panel = undefined;
	host.onError = undefined;
}

export function ensureSidePanelRegistry(scope: typeof globalThis = globalThis): SidePanelRegistry {
	const slots = scope as Record<PropertyKey, UntrustedRegistry>;
	if (isRegistry(slots[SIDE_PANEL_REGISTRY_KEY])) return slots[SIDE_PANEL_REGISTRY_KEY];
	const registry: SidePanelRegistry = {
		protocol: SIDE_PANEL_PROTOCOL,
		version: 1,
		register(provider) {
			const current = registryState(registry);
			const replaced = current.providers.get(provider.id);
			if (replaced && current.host) releaseAttachment(current.host, provider.id);
			current.providers.set(provider.id, provider);
			if (current.host) attachProvider(current.host, provider);
			return () => {
				if (current.providers.get(provider.id) !== provider) return;
				current.providers.delete(provider.id);
				if (current.host?.attachments.get(provider.id)?.provider === provider) {
					releaseAttachment(current.host, provider.id);
				}
			};
		},
		providers: () => [...registryState(registry).providers.values()],
		installHost() {
			const current = registryState(registry);
			if (current.host) detachSession(current.host);
			const host: HostState = { identity: {}, attachments: new Map() };
			current.host = host;
			return {
				attach(session, panel, onError) {
					if (current.host !== host) return () => {};
					detachSession(host);
					host.session = session;
					host.panel = panel;
					host.onError = onError;
					for (const provider of current.providers.values()) attachProvider(host, provider);
					return () => {
						if (current.host === host && host.session === session && host.panel === panel) detachSession(host);
					};
				},
				dispose() {
					if (current.host !== host) return;
					detachSession(host);
					current.host = undefined;
				},
			};
		},
		hasHost: () => registryState(registry).host !== undefined,
	};
	registryState(registry);
	slots[SIDE_PANEL_REGISTRY_KEY] = registry;
	return registry;
}

export function registerSidePanelProvider(provider: SidePanelProvider, scope: typeof globalThis): () => void {
	return ensureSidePanelRegistry(scope).register(provider);
}
