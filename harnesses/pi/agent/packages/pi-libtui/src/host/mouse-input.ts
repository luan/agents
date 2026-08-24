import type { MouseRect, TuiMouseEvent, TuiMouseEventType } from "../mouse.ts";

export interface ParsedMouseEvent {
	type: "press" | "release" | "drag" | "wheel" | "move";
	x: number;
	y: number;
	rawButton: number;
	wheel: -1 | 1 | undefined;
}

export type ParsedMouseInput =
	| { kind: "event"; event: ParsedMouseEvent }
	| { kind: "unsupported" }
	| { kind: "not-mouse" };

function modifiers(rawButton: number): Pick<TuiMouseEvent, "shift" | "alt" | "ctrl"> {
	return {
		shift: (rawButton & 4) !== 0,
		alt: (rawButton & 8) !== 0,
		ctrl: (rawButton & 16) !== 0,
	};
}

export function createEvent(type: TuiMouseEventType, parsed: ParsedMouseEvent, rect: MouseRect): TuiMouseEvent {
	const buttonBits = parsed.rawButton & 3;
	return {
		type,
		row: parsed.y - rect.y,
		col: parsed.x - rect.x,
		screenRow: parsed.y,
		screenCol: parsed.x,
		button: parsed.wheel === undefined && buttonBits !== 3 ? (buttonBits as 0 | 1 | 2) : undefined,
		wheel: parsed.wheel,
		...modifiers(parsed.rawButton),
	};
}

export function parseMouse(data: string): ParsedMouseInput {
	const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (sgr) {
		const rawButton = Number.parseInt(sgr[1]!, 10);
		const x = Number.parseInt(sgr[2]!, 10) - 1;
		const y = Number.parseInt(sgr[3]!, 10) - 1;
		if ((rawButton & 64) !== 0) {
			const direction = rawButton & 3;
			if (direction !== 0 && direction !== 1) return { kind: "unsupported" };
			return { kind: "event", event: { type: "wheel", x, y, rawButton, wheel: direction === 0 ? -1 : 1 } };
		}
		const motion = (rawButton & 32) !== 0;
		const noButton = (rawButton & 3) === 3;
		return {
			kind: "event",
			event: {
				type: sgr[4] === "m" ? "release" : motion ? (noButton ? "move" : "drag") : "press",
				x,
				y,
				rawButton,
				wheel: undefined,
			},
		};
	}

	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const rawButton = data.charCodeAt(3) - 32;
		if ((rawButton & 64) === 0) return { kind: "unsupported" };
		const direction = rawButton & 3;
		if (direction !== 0 && direction !== 1) return { kind: "unsupported" };
		return {
			kind: "event",
			event: {
				type: "wheel",
				x: data.charCodeAt(4) - 33,
				y: data.charCodeAt(5) - 33,
				rawButton,
				wheel: direction === 0 ? -1 : 1,
			},
		};
	}
	return { kind: "not-mouse" };
}

export function isPrimarySelectionRelease(event: ParsedMouseEvent): boolean {
	const button = event.rawButton & 3;
	return event.type === "release" && (button === 0 || button === 3);
}
