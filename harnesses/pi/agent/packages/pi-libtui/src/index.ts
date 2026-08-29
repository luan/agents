export {
	configureTuiAppearance,
	DEFAULT_TUI_APPEARANCE,
	getTuiAppearance,
	requestPhaseAnimation,
	resolveActivityPresentation,
	TUI_ACTIVITY_INDICATOR_OPTIONS,
	TUI_STATUS_PRESENTATION_OPTIONS,
	isTuiActivityMessageStyle,
	isTuiStatusPresentationStyle,
	isTuiAnimationSmoothness,
	isTuiAnimationSpeed,
	isTuiActivityIndicatorStyle,
	isTuiTextEffectStyle,
	isTuiTextEffectScope,
	isTuiPulseEffectStyle,
	subscribeTuiAppearance,
	type TuiAppearanceSettings,
	type TuiStatusPresentationStyle,
	type TuiActivityMessageStyle,
	type TuiActivityIndicatorStyle,
	type TuiActivityPresentation,
	type TuiAnimationSmoothness,
	type TuiAnimationSpeed,
	type TuiAnimationOverride,
	type TuiCursorStyle,
	type TuiIconPack,
	type TuiRequestPhase,
	type TuiTextEffectStyle,
	type TuiTextEffectScope,
	type TuiPulseEffectStyle,
} from "./appearance.ts";
export { statusPresentationFrame } from "./status-presentation.ts";
export {
	activityPresentationCadenceMs,
	activityPresentationFrame,
	type ActivityPresentationOptions,
} from "./activity-presentation.ts";
export {
	type TuiBackgroundPaint,
	type TuiBackgroundToken,
	type TuiColor,
	type TuiForegroundColor,
	type TuiForegroundPaint,
	type TuiForegroundToken,
	type TuiHue,
	type TuiShade,
	type TuiSwatch,
	type TuiTheme,
	tuiTheme,
} from "./color/theme.ts";
export {
	ComponentStack,
	type ComponentStackInputMode,
	type ComponentStackOptions,
	type ComponentStackSpan,
} from "./component-stack.ts";
export { sanitizeTuiField, sanitizeTuiText } from "./content/terminal-text.ts";
export {
	MarkdownText,
	type MarkdownTextOptions,
	semanticMarkdownTheme,
} from "./content/text.ts";
export {
	ActionPanel,
	type ActionPanelFooter,
	type ActionPanelGeometry,
	type ActionPanelMouseEvent,
	type ActionPanelOption,
	type ActionPanelOptions,
	type ActionPanelRect,
	type ActionPanelRowContext,
	type ActionPanelRowGeometry,
} from "./controls/action-panel.ts";
export {
	DialogButtonBar,
	type DialogButtonBarGeometry,
	type DialogButtonBarOptions,
	type DialogButtonGeometry,
	type DialogButtonSpec,
} from "./controls/dialog-button-bar.ts";
export { MultiSelect, type MultiSelectOptions } from "./controls/multi-select.ts";
export {
	type PickerOption,
	PickerPanel,
	type PickerPanelHost,
	type PickerPanelOptions,
	type PickerRowContext,
} from "./controls/picker-panel.ts";
export {
	SearchableSelect,
	type SearchableSelectOptions,
	type SearchableSelectRowContext,
	type SelectOption,
} from "./controls/searchable-select.ts";
export {
	SelectableList,
	type SelectableListGeometry,
	type SelectableListItemGeometry,
	type SelectableListOptions,
	type SelectableListRenderContext,
	type SelectableListRow,
} from "./controls/selectable-list.ts";
export {
	mountSelectionActionBar,
	placeSelectionActionBar,
	SelectionActionBar,
	type SelectionActionBarAction,
	type SelectionActionBarGeometry,
	type SelectionActionBarItemGeometry,
	type SelectionActionBarMount,
	type SelectionActionBarMountOptions,
	type SelectionActionBarOptions,
	type SelectionActionBarPlacementRequest,
	type SelectionActionBarTarget,
} from "./controls/selection-action-bar.ts";
export { SemanticInput } from "./controls/semantic-input.ts";
export { type Tab, TabBar } from "./controls/tab.ts";
export {
	type CursorRole,
	cursorStyle,
	isNativeCursorStyle,
	type MarkEditorCursorOptions,
	markEditorCursor,
	markSemanticCursorPosition,
	removeUnmarkedEditorCursor,
	renderSemanticCursor,
	renderVirtualCursor,
	type SemanticCursorOptions,
	stripCursorRoleMarkers,
	type VirtualCursorOptions,
} from "./cursor.ts";
export {
	type EditorTokenPillGeometry,
	type EditorTokenPillRenderContext,
	type EditorTokenPillResult,
	type EditorTokenPresentation,
	renderEditorPasteMarkerPills,
	renderEditorTokenPills,
} from "./decoration/editor-pills.ts";
export {
	icon,
	type PillContent,
	renderPillText,
	type TuiIconName,
	type TuiKeyIconPack,
} from "./decoration/glyphs.ts";
export {
	PointerInteractionController,
	type PointerInteractionHandlers,
	type PointerInteractionOptions,
} from "./decoration/pointer-interaction.ts";
export {
	backgroundAnsiAtColumn,
	contrastingPillBackground,
	renderPill,
} from "./decoration/powerline-pill.ts";
export type {
	ActivityIndicatorOptions,
	ProgressBarOptions,
	ProgressFrameOptions,
	TuiTitle,
	TuiTitleSource,
	TuiTitleValue,
} from "./decoration/status.ts";
export {
	ActivityIndicator,
	ProgressBar,
	progressFrame,
} from "./decoration/status.ts";
export {
	placeTransientPill,
	TransientPill,
	type TransientPillMessage,
	type TransientPillOptions,
	type TransientPillPlacementRequest,
} from "./decoration/transient-pill.ts";
export type {
	ActivityAnimationOverrides,
	ActivityFrame,
	MotionClock,
	MotionMount,
	MotionMountOptions,
	MotionRenderTarget,
	MotionTimerHandle,
} from "./motion.ts";
export {
	activityAnimatesText,
	activityFrame,
	animationSmoothnessCadenceMs,
	animationSpeedMultiplier,
	configuredAnimationCadenceMs,
	glyphFrame,
	mountConfiguredAnimation,
	MotionScheduler,
	pulseFrame,
	pulseGlyphFrame,
	lightningShimmerFrame,
	rainbowGlowShimmerFrame,
	rainbowShimmerFrame,
	sharedMotionScheduler,
	shimmerFrame,
	spinnerFrame,
} from "./motion.ts";
export {
	type AnchoredOverlayPlacement,
	type AnchoredOverlayRect,
	type AnchoredOverlayRequest,
	placeAnchoredOverlay,
} from "./overlay/anchored.ts";
export {
	type DialogHost,
	DialogOverlay,
	type DialogOverlayAnchor,
	DialogOverlayHost,
	type DialogOverlayOptions,
	offsetDialogHost,
} from "./overlay/dialog.ts";
export {
	FramedEditorOverlay,
	type FramedEditorOverlayGeometry,
	type FramedEditorOverlayOptions,
} from "./overlay/framed-editor.ts";
export { FullscreenOverlay, fullscreenOverlayOptions } from "./overlay/fullscreen.ts";
export {
	decorateDetailCard,
	type DetailCardContent,
	type HoverDetailCardMount,
	type HoverDetailCardOptions,
	type HoverDetailCardTarget,
	mountHoverDetailCard,
	overlayTotalWidth,
	renderDetailCard,
} from "./overlay/detail-card.ts";
export {
	type ModalOverlayComponent,
	type ModalOverlayMouseEvent,
	type ModalOverlayMountOptions,
	type MountedModalOverlayComponent,
	mountModalOverlay,
} from "./overlay/modal-mount.ts";
export { RenderedLinesCache } from "./render-cache.ts";
export { applyScrollbar } from "./scrollbar.ts";
export {
	highlightSyntaxBlock,
	SyntaxText,
	type SyntaxTextOptions,
	whenSyntaxReady,
} from "./syntax.ts";
export { stripTopLevelZoneMarkers } from "./terminal/embedding.ts";
