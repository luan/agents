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
	onRegister(listener: (provider: SidePanelProvider) => void): () => void;
}

interface RegistryState {
	readonly providers: Map<string, SidePanelProvider>;
	readonly listeners: Set<(provider: SidePanelProvider) => void>;
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
		typeof candidate.onRegister === "function"
	);
}

function registryState(registry: SidePanelRegistry): RegistryState {
	const existing = state.get(registry);
	if (existing) return existing;
	const created = {
		providers: new Map<string, SidePanelProvider>(),
		listeners: new Set<(provider: SidePanelProvider) => void>(),
	};
	state.set(registry, created);
	return created;
}

export function ensureSidePanelRegistry(scope: typeof globalThis = globalThis): SidePanelRegistry {
	const slots = scope as Record<PropertyKey, UntrustedRegistry>;
	if (isRegistry(slots[SIDE_PANEL_REGISTRY_KEY])) return slots[SIDE_PANEL_REGISTRY_KEY];
	const registry: SidePanelRegistry = {
		protocol: SIDE_PANEL_PROTOCOL,
		version: 1,
		register(provider) {
			const current = registryState(registry);
			current.providers.set(provider.id, provider);
			for (const listener of [...current.listeners]) {
				try {
					listener(provider);
				} catch {
					// Optional consumers must not prevent independent providers from registering.
				}
			}
			return () => {
				if (current.providers.get(provider.id) === provider) current.providers.delete(provider.id);
			};
		},
		providers: () => [...registryState(registry).providers.values()],
		onRegister(listener) {
			registryState(registry).listeners.add(listener);
			return () => registryState(registry).listeners.delete(listener);
		},
	};
	registryState(registry);
	slots[SIDE_PANEL_REGISTRY_KEY] = registry;
	return registry;
}

export function registerSidePanelProvider(provider: SidePanelProvider): () => void {
	return ensureSidePanelRegistry().register(provider);
}
