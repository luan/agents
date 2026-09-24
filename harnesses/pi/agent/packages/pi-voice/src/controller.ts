import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCodexVoiceAuth } from "./auth.ts";
import { buildRealtimeInitialItems, voiceInstructions } from "./context.ts";
import { NativeCodexRealtimePeer } from "./conversation/native-peer.ts";
import { CodexRealtimeConversation } from "./conversation/session.ts";
import type { CodexRealtimePeer } from "./conversation/peer.ts";
import { CodexDictationSession } from "./dictation/session.ts";
import { getVoiceConfig } from "./settings.ts";
import { renderRealtimeDelegation } from "./prompts.ts";
import type { RealtimeVoiceTurn } from "./turns.ts";
export class VoiceController {
	private conversation?: CodexRealtimeConversation;
	private dictation?: CodexDictationSession;
	private context?: ExtensionContext;
	private generation = 0;
	private controller?: AbortController;
	private replacing = false;
	private held: RealtimeVoiceTurn[] = [];
	private refreshTranscript = "";
	private compacting = false;
	private peerFactory: () => CodexRealtimePeer = () => new NativeCodexRealtimePeer();
	status = "off";
	onChange: () => void = () => {};
	private listeners = new Set<() => void>();
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private changed(): void {
		this.onChange();
		for (const listener of this.listeners) listener();
	}
	constructor(private readonly pi: ExtensionAPI) {}
	bind(ctx: ExtensionContext): void {
		this.context = ctx;
	}
	get active(): boolean {
		return this.conversation !== undefined;
	}
	get recording(): boolean {
		return this.dictation !== undefined;
	}
	get muted(): boolean {
		return this.conversation?.microphoneMuted ?? false;
	}
	private update(status: string): void {
		this.status = status;
		this.changed();
	}
	async start(ctx: ExtensionContext, peerFactory?: () => CodexRealtimePeer): Promise<void> {
		if (this.conversation || this.controller || this.dictation)
			throw new Error("Stop the current voice mode before starting another");
		this.context = ctx;
		this.peerFactory = peerFactory ?? (() => new NativeCodexRealtimePeer());
		const generation = ++this.generation;
		const controller = new AbortController();
		this.controller = controller;
		this.update("preparing context");
		try {
			const config = getVoiceConfig();
			const initial = await buildRealtimeInitialItems(ctx, config, controller.signal);
			controller.signal.throwIfAborted();
			const call = await this.open(ctx, generation, initial, false);
			if (this.generation === generation) call?.greet(initial.length > 0);
		} catch (error) {
			if (this.generation === generation) await this.stop();
			throw error;
		}
	}
	private async open(
		ctx: ExtensionContext,
		generation: number,
		initial: Awaited<ReturnType<typeof buildRealtimeInitialItems>>,
		muted: boolean,
	): Promise<CodexRealtimeConversation | undefined> {
		const auth = await resolveCodexVoiceAuth(ctx);
		const instructions = await voiceInstructions(ctx.cwd);
		if (generation !== this.generation) return;
		const call = new CodexRealtimeConversation(
			{
				onError: (error) => {
					if (this.conversation === call) {
						ctx.ui.notify(error.message, "error");
						void this.stop();
					}
				},
				onDrop: (error) => {
					if (this.conversation === call) void this.dropped(ctx, error);
				},
				onStatus: (status) => {
					if (this.conversation === call) this.update(status);
				},
				onTurn: (turn) => {
					if (this.conversation === call) this.accept(turn);
				},
				onUserTranscript: (text) => {
					if (this.conversation === call) {
						this.recordRefresh(text);
						this.pi.appendEntry("pi-voice/transcript", { text });
					}
				},
				onTranscriptTail: (text) => {
					if (text && this.conversation === call) {
						this.recordRefresh(text);
						this.pi.sendMessage(
							{ customType: "pi-voice/tail", content: `Earlier voice transcript:\n${text}`, display: false },
							{ triggerTurn: false },
						);
					}
				},
			},
			this.peerFactory(),
		);
		this.conversation = call;
		await call.start(auth, getVoiceConfig(), instructions, initial, muted);
		if (generation !== this.generation) {
			await call.close();
			return;
		}
		call.markEstablished();
		this.update("listening");
		return call;
	}
	private recordRefresh(text: string): void {
		// Keep recent speech alongside the generated summary; larger histories remain in the Pi transcript.
		if (this.replacing) this.refreshTranscript = `${this.refreshTranscript}\n${text}`.slice(-64_000);
	}
	private accept(turn: RealtimeVoiceTurn): void {
		if (!turn.delegationId) {
			this.pi.appendEntry("pi-voice/reply", { text: turn.input });
			return;
		}
		if (this.replacing || this.compacting) {
			this.recordRefresh(renderRealtimeDelegation(turn.input, turn.transcriptDelta));
			this.held.push(turn);
			return;
		}
		const ctx = this.context;
		if (!ctx || !this.conversation) return;
		if (turn.delegationId) this.conversation.activateDelegation(turn.delegationId);
		this.pi.sendMessage(
			{
				customType: "pi-voice/delegation",
				content: renderRealtimeDelegation(turn.input, turn.transcriptDelta),
				display: false,
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}
	private flush(): void {
		if (!this.replacing && !this.compacting) for (const turn of this.held.splice(0)) this.accept(turn);
	}
	async refresh(ctx: ExtensionContext, sourceLeaf?: string): Promise<void> {
		if (!this.conversation || this.replacing || !getVoiceConfig().voice.refreshAfterCompaction) return;
		this.replacing = true;
		const previous = this.conversation,
			generation = this.generation,
			muted = this.muted;
		this.refreshTranscript = "";
		let previousClosed = false;
		this.update("refreshing context");
		try {
			const initial = await buildRealtimeInitialItems(ctx, getVoiceConfig(), this.controller?.signal, sourceLeaf);
			if (this.generation !== generation) return;
			await previous.waitForInput(this.controller!.signal);
			previousClosed = true;
			await previous.close();
			if (this.generation !== generation) return;
			if (this.refreshTranscript.trim())
				initial.push({
					type: "message",
					role: "developer",
					content: [
						{
							type: "input_text",
							text: `Recent voice history received during context refresh:\n${this.refreshTranscript}`,
						},
					],
				});
			this.conversation = undefined;
			await this.open(ctx, generation, initial, muted);
		} catch (error) {
			ctx.ui.notify(
				`Voice context refresh failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
			if (this.generation !== generation) return;
			if (previousClosed) await this.stop();
			else this.update("listening");
		} finally {
			this.replacing = false;
			this.flush();
		}
	}
	private async dropped(ctx: ExtensionContext, error: Error): Promise<void> {
		if (!getVoiceConfig().voice.autoResume || this.replacing) {
			ctx.ui.notify(error.message, "error");
			await this.stop();
			return;
		}
		this.replacing = true;
		const generation = this.generation,
			muted = this.muted;
		this.update("reconnecting");
		try {
			await this.conversation?.close();
			this.conversation = undefined;
			const initial = await buildRealtimeInitialItems(ctx, getVoiceConfig(), this.controller?.signal);
			if (this.generation !== generation) return;
			await this.open(ctx, generation, initial, muted);
		} catch (failure) {
			ctx.ui.notify(failure instanceof Error ? failure.message : String(failure), "error");
			await this.stop();
		} finally {
			this.replacing = false;
			this.flush();
		}
	}
	async toggleDictation(ctx: ExtensionContext): Promise<void> {
		if (this.dictation) {
			await this.dictation.finish();
			this.dictation = undefined;
			this.update("off");
			return;
		}
		if (this.active || this.controller) throw new Error("Stop conversation before starting dictation");
		this.context = ctx;
		const dictation = new CodexDictationSession({
			onError: (error) => {
				ctx.ui.notify(error.message, "error");
				if (this.dictation === dictation) {
					this.dictation = undefined;
					this.update("off");
				}
			},
			onStatus: (status) => this.update(status),
			onTranscript: (text) => {
				const current = ctx.ui.getEditorText();
				if (this.dictation === dictation) ctx.ui.setEditorText(`${current}${current ? "\n" : ""}${text}`);
			},
		});
		this.dictation = dictation;
		this.update("connecting");
		try {
			const auth = await resolveCodexVoiceAuth(ctx);
			if (this.dictation !== dictation) return;
			await dictation.start(auth, getVoiceConfig());
			this.changed();
		} catch (error) {
			await dictation.close();
			if (this.dictation === dictation) {
				this.dictation = undefined;
				this.update("off");
			}
			throw error;
		}
	}
	mute(): void {
		this.conversation?.setInputMuted(!this.muted);
		this.changed();
	}
	input(text: string, behavior?: "steer" | "followUp"): void {
		this.conversation?.piInput(text, behavior);
	}
	delta(text: string): void {
		this.conversation?.streamAgentDelta(text);
	}
	result(text: string, final: boolean): void {
		if (final) this.conversation?.agentResult(text);
		else this.conversation?.agentProgress(text);
	}
	settle(): void {
		this.conversation?.settleAgentTurn();
		this.compacting = false;
		this.flush();
	}
	cancelCompaction(): void {
		this.compacting = false;
		this.flush();
	}
	compaction(signal?: AbortSignal): void {
		this.compacting = true;
		signal?.addEventListener(
			"abort",
			() => {
				this.compacting = false;
				this.flush();
			},
			{ once: true },
		);
	}
	async compacted(ctx: ExtensionContext): Promise<void> {
		try {
			await this.refresh(ctx);
		} finally {
			this.compacting = false;
			this.flush();
		}
	}
	async stop(triggerTurn = true): Promise<void> {
		this.generation++;
		this.controller?.abort();
		this.controller = undefined;
		const call = this.conversation,
			dictation = this.dictation;
		this.replacing = true;
		try {
			await Promise.all([call?.close(), dictation?.close()]);
		} finally {
			this.conversation = undefined;
			this.dictation = undefined;
			// Accepted requests remain user work even when the call ends.
			const held = this.held.splice(0);
			this.replacing = false;
			this.compacting = false;
			for (const turn of held)
				this.pi.sendMessage(
					{
						customType: "pi-voice/delegation",
						content: renderRealtimeDelegation(turn.input, turn.transcriptDelta),
						display: false,
					},
					{ deliverAs: "followUp", triggerTurn },
				);
			this.update("off");
		}
	}
}
