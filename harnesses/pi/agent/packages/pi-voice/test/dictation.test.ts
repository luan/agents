import { expect, test } from "bun:test";
import { WebSocket, WebSocketServer } from "ws";
import { CodexDictationTranscriber } from "../src/dictation/transcriber.ts";

test("dictation preserves phone audio received before its connection becomes ready", async () => {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test listener");
	const messages: string[] = [];
	const received = Promise.withResolvers<void>();
	const connect = Promise.withResolvers<void>();
	server.on("connection", (socket) =>
		socket.on("message", (data) => {
			messages.push(data.toString());
			if (messages.length === 3) received.resolve();
		}),
	);
	const errors: string[] = [];
	const transcriber = new CodexDictationTranscriber(
		{ onError: (error) => errors.push(error.message), onStatus: () => {} },
		async () => {
			await connect.promise;
			const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
			await new Promise<void>((resolve, reject) => {
				socket.once("open", resolve);
				socket.once("error", reject);
			});
			return socket;
		},
	);
	try {
		transcriber.append(Buffer.from([1, 0]));
		const starting = transcriber.start({
			headers: new Headers(),
			baseUrl: "https://test.invalid",
			officialCodex: true,
		});
		transcriber.append(Buffer.from([2, 0]));
		connect.resolve();
		await starting;
		await received.promise;
		expect(messages.map((message) => JSON.parse(message).type)).toEqual([
			"session.update",
			"input_audio_buffer.append",
			"input_audio_buffer.append",
		]);
		expect(messages.slice(1).map((message) => JSON.parse(message).audio)).toEqual(["AQA=", "AgA="]);
		expect(errors).toEqual([]);
	} finally {
		await transcriber.close();
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test.each([
	{ audio: false, transcript: "", error: "No microphone audio was received" },
	{ audio: true, transcript: "", error: "No speech was detected" },
	{ audio: true, transcript: "The draft is ready.", error: undefined },
])("dictation reports an empty recording and returns a completed draft: %j", async ({ audio, transcript, error }) => {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test listener");
	server.on("connection", (socket) =>
		socket.on("message", (data) => {
			if (JSON.parse(data.toString()).type === "input_audio_buffer.commit")
				socket.send(
					JSON.stringify({
						type: "conversation.item.input_audio_transcription.completed",
						transcript,
					}),
				);
		}),
	);
	const transcriber = new CodexDictationTranscriber({ onError: () => {}, onStatus: () => {} }, async () => {
		const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		return socket;
	});
	try {
		await transcriber.start({ headers: new Headers(), baseUrl: "https://test.invalid", officialCodex: true });
		if (audio) transcriber.append(Buffer.alloc(4_800));
		if (error) await expect(transcriber.finish()).rejects.toThrow(error);
		else expect(await transcriber.finish()).toBe(transcript);
	} finally {
		await transcriber.close();
		for (const socket of server.clients) socket.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
