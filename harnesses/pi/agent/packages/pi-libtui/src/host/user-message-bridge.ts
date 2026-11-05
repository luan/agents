import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getTuiAppearance } from "../appearance.ts";
import { nativeSurfaceCap } from "../terminal/color-compatibility.ts";

const BRIDGE_PROTOCOL = "pi-libtui/user-message-bridge/v1" as const;
const BRIDGE_KEY = Symbol.for(BRIDGE_PROTOCOL);

interface UserMessageBridge {
	readonly protocol: typeof BRIDGE_PROTOCOL;
	acquire(): () => void;
}

// type-boundary: another installed libtui copy can own this prototype lease; isBridge validates its public contract.
type UntrustedBridge = unknown;

function isBridge(value: UntrustedBridge): value is UserMessageBridge {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<UserMessageBridge>;
	return candidate.protocol === BRIDGE_PROTOCOL && typeof candidate.acquire === "function";
}

function bubbleWidth(width: number): number {
	// Narrow panes retain the native layout so markdown still has room to wrap.
	return Math.min(60, width < 40 ? width : Math.floor(width * 0.75));
}

/** Pi 0.87 has no user-message layout hook. Replace this lease when one becomes public. */
export function installUserMessageBridge(): () => void {
	const prototype = UserMessageComponent.prototype;
	const existing: UntrustedBridge = Reflect.get(prototype, BRIDGE_KEY);
	if (isBridge(existing)) return existing.acquire();
	const render = prototype.render;
	const handleMouse = prototype.handleMouse;
	const mouseDescriptor = Object.getOwnPropertyDescriptor(prototype, "handleMouse");
	let leases = 0;
	const layouts = new WeakMap<UserMessageComponent, { width: number; nativeWidth: number }>();
	const enabled = () => leases > 0 && getTuiAppearance().userMessageBubbles;
	const wrappedRender: typeof render = function (this: UserMessageComponent, width) {
		layouts.delete(this);
		if (!enabled()) return render.call(this, width);
		const innerWidth = bubbleWidth(width);
		if (innerWidth < 4) return render.call(this, width);
		// Preserve native markdown, background, transformers, and OSC message markers.
		const lines = render.call(this, innerWidth - 2).slice(1, -1);
		if (lines.length === 0) return [];
		// Measure rendered text, not markdown source; retain one space before the right cap.
		const fittedWidth = Math.min(
			innerWidth,
			lines.reduce((maximum, line) => Math.max(maximum, visibleWidth(stripTerminalSequences(line).trimEnd()) + 3), 4),
		);
		layouts.set(this, { width: fittedWidth, nativeWidth: innerWidth - 2 });
		const gutter = " ".repeat(width - fittedWidth);
		const result = lines.map((line) => {
			// Crop only native trailing padding; keep its original wrapping and mouse layout.
			return (
				gutter + nativeSurfaceCap(line, "█") + sliceByColumn(line, 0, fittedWidth - 2) + nativeSurfaceCap(line, "█")
			);
		});
		result.unshift(gutter + nativeSurfaceCap(lines[0]!, "▄".repeat(fittedWidth)));
		result.push(gutter + nativeSurfaceCap(lines[lines.length - 1]!, "▀".repeat(fittedWidth)));
		result[0] = `\x1b]133;A\x07${result[0]}`;
		// Pi strips only leading transcript markers when drawing fullscreen frames.
		result[result.length - 1] = `\x1b]133;B\x07\x1b]133;C\x07${result[result.length - 1]}`;
		return result;
	};
	const wrappedMouse: typeof handleMouse = function (this: UserMessageComponent, event) {
		if (!enabled()) return handleMouse.call(this, event);
		const layout = layouts.get(this);
		const width = layout?.width ?? bubbleWidth(event.width);
		if (width < 4) return handleMouse.call(this, event);
		const x = event.x - (event.width - width) - 1;
		if (x < 0 || x >= width - 2) return undefined;
		if (event.y === 0 || event.y === event.height - 1) return undefined;
		return handleMouse.call(this, {
			...event,
			x,
			width: layout?.nativeWidth ?? width - 2,
		});
	};
	const bridge: UserMessageBridge = {
		protocol: BRIDGE_PROTOCOL,
		acquire() {
			leases += 1;
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				if (--leases > 0) return;
				if (prototype.render === wrappedRender) prototype.render = render;
				if (prototype.handleMouse === wrappedMouse) {
					if (mouseDescriptor) Object.defineProperty(prototype, "handleMouse", mouseDescriptor);
					else Reflect.deleteProperty(prototype, "handleMouse");
				}
				if (Reflect.get(prototype, BRIDGE_KEY) === bridge) Reflect.deleteProperty(prototype, BRIDGE_KEY);
			};
		},
	};
	prototype.render = wrappedRender;
	prototype.handleMouse = wrappedMouse;
	Object.defineProperty(prototype, BRIDGE_KEY, { configurable: true, value: bridge });
	return bridge.acquire();
}
