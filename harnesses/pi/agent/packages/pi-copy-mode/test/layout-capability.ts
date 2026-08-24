import {
	type FullscreenLayout,
	type FullscreenLayoutCapability,
	type LayoutBox,
	type LayoutFrame,
	type LayoutScrollView,
	publishFullscreenLayoutCapability,
} from "pi-libtui/mouse";

interface TestRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface TestScrollView extends LayoutScrollView {
	scrollTop: number;
}

interface TestBox extends Omit<LayoutBox, "children" | "clip" | "rect" | "scrollView"> {
	rect: TestRect;
	clip: TestRect;
	children: TestBox[];
	scrollView?: TestScrollView;
}

interface TestRenderer {
	currentLayout?: LayoutFrame;
	selectionAnchor?: { row: number; col: number; scrollView: TestScrollView; boundary?: boolean };
	selectionFocus?: { row: number; col: number; scrollView: TestScrollView; boundary?: boolean };
}

function intersect(left: TestRect, right: TestRect): TestRect {
	const x = Math.max(left.x, right.x);
	const y = Math.max(left.y, right.y);
	return {
		x,
		y,
		width: Math.max(0, Math.min(left.x + left.width, right.x + right.width) - x),
		height: Math.max(0, Math.min(left.y + left.height, right.y + right.height) - y),
	};
}

function primaryBox(box: TestBox, scrollView: TestScrollView): TestBox | undefined {
	if (box.scrollView === scrollView) return box;
	for (const child of box.children) {
		const found = primaryBox(child, scrollView);
		if (found) return found;
	}
	return undefined;
}

const testCapability: FullscreenLayoutCapability = {
	protocol: "pi-libtui/fullscreen-layout/v1",
	version: 1,
	resolve(renderer): FullscreenLayout | undefined {
		const candidate = renderer as TestRenderer;
		const frame = candidate.currentLayout;
		const scrollView = frame?.primaryScrollView;
		if (!frame || !scrollView) return undefined;
		const box = primaryBox(frame.root as TestBox, scrollView);
		const lines = box?.scrollContentLines;
		const viewport = box ? intersect(box.rect, box.clip) : undefined;
		if (!box || !lines || !viewport || viewport.width <= 0 || viewport.height <= 0) return undefined;
		return {
			frame,
			primaryBox: box,
			primaryScrollView: scrollView,
			lines,
			viewport: { ...viewport, scrollTop: scrollView.scrollTop },
			get selectionAnchor() {
				return candidate.selectionAnchor;
			},
			get selectionFocus() {
				return candidate.selectionFocus;
			},
			setSelection(anchor, focus) {
				candidate.selectionAnchor = anchor;
				candidate.selectionFocus = focus;
			},
			point(point, boundary = false) {
				return { ...point, scrollView, ...(boundary ? { boundary: true } : {}) };
			},
			screenPoint(point) {
				return { row: box.rect.y + point.row - scrollView.scrollTop, col: box.rect.x + point.col };
			},
		};
	},
};

let removeCapability: () => void = () => {};

/** Install the public structural capability used by copy-mode's focused runtime harness. */
export function ensureTestLayoutCapability(): void {
	removeCapability();
	removeCapability = publishFullscreenLayoutCapability(testCapability);
}

/** Temporarily remove the test provider to prove copy-mode's absent-capability fallback. */
export function removeTestLayoutCapability(): void {
	removeCapability();
	removeCapability = () => {};
}

ensureTestLayoutCapability();
