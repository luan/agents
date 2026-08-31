import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	activityPresentationCadenceMs,
	getTuiAppearance,
	requestPhaseAnimation,
	sharedMotionScheduler,
	subscribeTuiAppearance,
} from "pi-libtui";
import { editorCompositionCadenceMs } from "pi-libtui/editor";
import { getCustomEditorSettings, registerCustomEditorSettings } from "./config/settings.ts";
import { resolveEditorComposition } from "./core/composition.ts";
import { TuiState } from "./runtime/state.ts";
import { createFooter } from "./ui/footer.ts";
import { installCustomEditor } from "./ui/pi-custom-editor.ts";

export default function tuiExtension(pi: ExtensionAPI): void {
	const state = new TuiState();
	let removeEditor: (() => void) | undefined;
	let removeMotion: (() => void) | undefined;
	let activeSession: object | undefined;
	let requestRender = (): void => {};
	let motionTarget: { requestRender(): void } | undefined;
	let activeContext: ExtensionContext | undefined;
	const isActive = (ctx: ExtensionContext): boolean => ctx.sessionManager === activeSession;
	const syncWorkingPlacement = (): void => {
		activeContext?.ui.setWorkingVisible(getCustomEditorSettings().workingPlacement === "transcript");
	};
	const startMotion = (): void => {
		removeMotion?.();
		removeMotion = undefined;
		const target = motionTarget;
		if (!target) return;
		let disposeMount: (() => void) | undefined;
		const sync = (): void => {
			disposeMount?.();
			const appearance = getTuiAppearance();
			const placement = getCustomEditorSettings().workingPlacement;
			const activityCadence =
				state.active && placement !== "transcript" && placement !== "hidden"
					? activityPresentationCadenceMs(
							requestPhaseAnimation("working", appearance),
							appearance.animationSmoothness,
							appearance.animationSpeed,
						)
					: undefined;
			const compositionCadence = editorCompositionCadenceMs(
				resolveEditorComposition(getCustomEditorSettings()).style,
				state.active,
			);
			const cadenceMs = [activityCadence, compositionCadence]
				.filter((value): value is number => value !== undefined)
				.reduce<number | undefined>(
					(minimum, value) => (minimum === undefined ? value : Math.min(minimum, value)),
					undefined,
				);
			if (cadenceMs === undefined) return;
			disposeMount = sharedMotionScheduler.mount(target, { cadenceMs }).dispose;
		};
		const unsubscribe = subscribeTuiAppearance(() => {
			sync();
			requestRender();
		});
		sync();
		removeMotion = () => {
			unsubscribe();
			disposeMount?.();
		};
	};
	const unregisterSettings = registerCustomEditorSettings(() => {
		syncWorkingPlacement();
		startMotion();
		requestRender();
	});
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		activeSession = ctx.sessionManager as object;
		activeContext = ctx;
		state.reset();
		syncWorkingPlacement();
		removeEditor = installCustomEditor(
			ctx,
			state,
			() => (ctx.model?.reasoning ? pi.getThinkingLevel() : undefined),
			(tui) => {
				motionTarget = tui;
				requestRender = () => tui.requestRender();
				startMotion();
			},
		);
		ctx.ui.setFooter((tui, theme, data) => {
			requestRender = () => tui.requestRender();
			motionTarget = tui;
			startMotion();
			return createFooter(ctx, state, () => (ctx.model?.reasoning ? pi.getThinkingLevel() : undefined))(
				tui,
				theme,
				data,
			);
		});
	});
	pi.on("agent_start", (_event, ctx) => {
		if (isActive(ctx)) {
			state.start();
			startMotion();
			requestRender();
		}
	});
	pi.on("agent_end", (_event, ctx) => {
		if (isActive(ctx)) {
			state.stop();
			removeMotion?.();
			removeMotion = undefined;
			requestRender();
		}
	});
	pi.on("message_update", (_event, ctx) => {
		if (isActive(ctx)) {
			state.touch();
			requestRender();
		}
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (!isActive(ctx)) return;
		ctx.ui.setWorkingVisible(true);
		removeMotion?.();
		removeEditor?.();
		removeMotion = undefined;
		removeEditor = undefined;
		requestRender = (): void => {};
		motionTarget = undefined;
		activeSession = undefined;
		activeContext = undefined;
		ctx.ui.setFooter(undefined);
	});
	pi.on("session_shutdown", (event) => {
		if (event.reason === "reload" || event.reason === "quit") unregisterSettings();
	});
}
