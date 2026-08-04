export { type EditorFactory, type EditorLayer, type EditorUi, installEditorLayer } from "../editor-composition";
export { setOrderedAboveEditorWidget } from "../ordered-widgets";
export {
	type AnimationMount,
	AnimationRenderScheduler,
	type AnimationRenderTarget,
	AnimationScheduler,
	ansiFgToRgb,
	cappedRunningElapsedMs,
	markLiveTurnStarted,
	parseHexRgb,
	pulseGlyph,
	type Rgb,
	RUNNING_ANIMATION_MAX_MS,
	resetLiveTurnForTests,
	rgbBg,
	rgbFg,
	runningAnimationStalled,
	runningCellElapsedMs,
	runningFrame,
	scaleRgb,
	sharedAnimationRenderScheduler,
	shineText,
	shouldAnimateRunningCell,
	type ThemeColorSource,
	themeRoleAnsi,
	themeRoleToRgb,
	triangleWave,
} from "./animation";
export { EmptyComponent, registerExtensionMessageRenderer, textComponent } from "./components";
export { createSelectController } from "./controllers";
export { enforceNoRawTuiSurfaceCalls } from "./enforcement";
export { defineExtensionTui } from "./facade";
export { RenderedLineCache } from "./render-cache";
export { renderView } from "./renderer";
export { createResource } from "./resources";
export { createSurfaceRegistry } from "./surfaces";
export {
	clampAnsiLine,
	keepBackgroundAcrossResets,
	padToVisibleWidth,
	paintAnsiBackgroundRow,
	sgrResetsBackground,
	truncateToWidthCompat,
} from "./text";
export type { Emphasis, ListItem, OverflowMode, RenderOptions, RenderTheme, Tone, ViewNode } from "./types";
export { view } from "./view";
