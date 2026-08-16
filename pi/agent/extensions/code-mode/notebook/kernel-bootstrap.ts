/**
 * The JavaScript injected into the Deno kernel once, before any cell runs.
 *
 * It installs the cell surface documented in payload.ts:22 (`tools`, `ALL_TOOLS`, `text`, `image`,
 * `audio`, `generatedImage`, `notify`, `store`, `load`, `yield_control`, `exit`) and routes every
 * one of them to the loopback bridge. Cell code is identical to the Rust path.
 *
 * The whole source is one block, so only the `globalThis` assignments survive into cell scope.
 */

// Bounds a runaway cell before it hits the bridge's 34 MB request ceiling in bridge-protocol.ts:10.
const MAX_CELL_OUTPUT_CHARS = 32 * 1024 * 1024;
const MAX_CELL_OUTPUT_ITEMS = 10_000;
const MAX_TEXT_ITEM_CHARS = 4 * 1024 * 1024;

/** `exit()` throws with this name. Jupyter reports it as the error's `ename`. */
export const NOTEBOOK_EXIT_NAME = "PiNotebookExit";

/** The global the extension calls to frame each cell. */
export const NOTEBOOK_RUNTIME_GLOBAL = "__pi_runtime";

export function notebookBootstrapSource(origin: string, token: string): string {
	return `{
  const __origin = ${JSON.stringify(origin)};
  const __token = ${JSON.stringify(token)};
  const { getHeapStatistics: __getHeapStatistics } = await import("node:v8");
  const __state = {
    cellId: null,
    requestId: 0,
    pending: new Set(),
    pendingErrors: [],
    toolPending: new Set(),
    toolNames: {},
    outputChars: 0,
    outputItems: 0,
    outputTruncated: false,
    store: new Map(),
  };
  const __decode = (_key, value) => {
    if (!value || typeof value !== "object") return value;
    if (value.__pi_type === "bigint") return BigInt(value.value);
    if (value.__pi_type === "bytes") return Uint8Array.from(atob(value.value), (char) => char.charCodeAt(0));
    return value;
  };
  const __post = async (payload) => {
    const response = await fetch(__origin + "/bridge", {
      method: "POST",
      headers: { authorization: "Bearer " + __token, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    const value = text ? JSON.parse(text, __decode) : {};
    if (!response.ok || !value.ok) throw new Error(value.error || "Notebook bridge request failed");
    return value.result;
  };
  const __track = (promise) => {
    __state.pending.add(promise);
    void promise.then(
      () => __state.pending.delete(promise),
      (error) => {
        __state.pending.delete(promise);
        __state.pendingErrors.push(error);
      },
    );
    return promise;
  };
  const __trackTool = (promise) => {
    __state.toolPending.add(promise);
    void promise.then(
      () => __state.toolPending.delete(promise),
      () => __state.toolPending.delete(promise),
    );
    return promise;
  };
  const __stringify = (value) => {
    if (typeof value === "string") return value;
    if (value === undefined) return "undefined";
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const __split = (items) => {
    const expanded = [];
    for (const item of items) {
      if (item.type !== "input_text" || !item.text || item.text.length <= ${MAX_TEXT_ITEM_CHARS}) {
        expanded.push(item);
        continue;
      }
      for (let offset = 0; offset < item.text.length;) {
        let end = Math.min(item.text.length, offset + ${MAX_TEXT_ITEM_CHARS});
        const before = item.text.charCodeAt(end - 1);
        const after = item.text.charCodeAt(end);
        if (end < item.text.length && before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) end -= 1;
        expanded.push({ ...item, text: item.text.slice(offset, end) });
        offset = end;
      }
    }
    return expanded;
  };
  const __emit = (items) => {
    if (!__state.cellId) throw new Error("Notebook helper called outside an active exec cell");
    if (__state.outputTruncated) return;
    const accepted = [];
    for (const item of __split(items)) {
      const size = (item.text || item.image_url || item.audio_url || "").length;
      if (__state.outputItems >= ${MAX_CELL_OUTPUT_ITEMS} || __state.outputChars + size > ${MAX_CELL_OUTPUT_CHARS}) {
        const notice = { type: "input_text", text: "[Notebook cell output truncated]" };
        accepted.push(notice);
        __state.outputChars += notice.text.length;
        __state.outputItems += 1;
        __state.outputTruncated = true;
        break;
      }
      accepted.push(item);
      __state.outputChars += size;
      __state.outputItems += 1;
    }
    for (const item of accepted) __track(__post({ kind: "emit", cellId: __state.cellId, items: [item] }));
  };
  const __reportMemory = async (cellId) => {
    const usage = Deno.memoryUsage();
    await __post({
      kind: "memory",
      cellId,
      usage: {
        heapUsedBytes: usage.heapUsed,
        heapTotalBytes: usage.heapTotal,
        rssBytes: usage.rss,
        externalBytes: usage.external,
        heapLimitBytes: __getHeapStatistics().heap_size_limit,
      },
    });
  };
  // The Rust host takes base64 data URIs only. An http(s) URL is rejected here for the same reason:
  // the model must not make the runtime fetch a remote asset on its behalf.
  const __dataUrl = (url, kind) => {
    if (!url || !/^data:/i.test(url)) {
      if (/^https?:/i.test(url || "")) throw new TypeError("remote " + kind + " URLs are not supported; pass a base64 data URI instead");
      throw new TypeError("invalid " + kind + " output; pass a base64 data URI instead");
    }
    if (!/^data:[a-z0-9.+-]+\\/[a-z0-9.+-]+;base64,[a-z0-9+\\/=]+$/i.test(url)) {
      throw new TypeError("invalid " + kind + " output; expected base64 " + kind + " data");
    }
    return url;
  };
  const __mcpDataUrl = (block) => block.data.toLowerCase().startsWith("data:")
    ? block.data
    : "data:" + (block.mimeType || "application/octet-stream") + ";base64," + block.data;
  const __image = (value, detail) => {
    let image_url;
    let embeddedDetail;
    if (typeof value === "string") image_url = value;
    else if (value && typeof value.image_url === "string") {
      image_url = value.image_url;
      embeddedDetail = value.detail;
    } else if (value && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
      if (!value.data) throw new TypeError("image expected MCP image data");
      image_url = __mcpDataUrl(value);
      const metadataDetail = value._meta?.["codex/imageDetail"];
      embeddedDetail = ["auto", "low", "high", "original"].includes(metadataDetail) ? metadataDetail : undefined;
    } else throw new TypeError("image expects a data URL or image content item");
    image_url = __dataUrl(image_url, "image");
    const requestedDetail = detail !== undefined ? detail : embeddedDetail;
    let resolvedDetail = "high";
    if (requestedDetail !== undefined && requestedDetail !== null) {
      if (typeof requestedDetail !== "string") throw new TypeError("image detail must be a string when provided");
      resolvedDetail = requestedDetail.toLowerCase();
      if (!["auto", "low", "high", "original"].includes(resolvedDetail)) {
        throw new TypeError("image detail must be one of: auto, low, high, original");
      }
    }
    __emit([{ type: "input_image", image_url, detail: resolvedDetail }]);
  };
  const __audio = (value) => {
    let audio_url;
    if (typeof value === "string") audio_url = value;
    else if (value && typeof value.audio_url === "string") audio_url = value.audio_url;
    else if (value && value.type === "audio" && typeof value.data === "string" && typeof value.mimeType === "string") {
      if (!value.data) throw new TypeError("audio expected MCP audio data");
      audio_url = __mcpDataUrl(value);
    } else throw new TypeError("audio expects a data URL or audio content item");
    __emit([{ type: "input_audio", audio_url: __dataUrl(audio_url, "audio") }]);
  };
  // A Proxy answers any name, so an unknown tool becomes a dispatch error from the bridge instead of
  // "tools.x is not a function". The dispatch error names the tool and lists the near misses.
  const __tools = new Proxy({}, {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      return (input) => {
        if (!__state.cellId) throw new Error("Nested tool called outside an active exec cell");
        const requestId = ++__state.requestId;
        const toolName = __state.toolNames[name] || { name };
        return __trackTool(__post({ kind: "tool", cellId: __state.cellId, requestId, toolName, input }));
      };
    },
  });
  const __runtime = {
    async begin(cellId, tools, toolNames) {
      __state.cellId = cellId;
      __state.toolNames = toolNames || {};
      __state.requestId = 0;
      __state.pending = new Set();
      __state.pendingErrors = [];
      __state.toolPending = new Set();
      __state.outputChars = 0;
      __state.outputItems = 0;
      __state.outputTruncated = false;
      globalThis.tools = __tools;
      globalThis.ALL_TOOLS = tools || [];
      await __reportMemory(cellId);
    },
    async flush(cellId) {
      if (__state.cellId !== cellId) throw new Error("Notebook cell identity changed while executing");
      try {
        await Promise.allSettled([...__state.pending]);
        const [error] = __state.pendingErrors.splice(0);
        if (error) throw error;
        await __post({ kind: "cancel_tools", cellId });
        await Promise.allSettled([...__state.toolPending]);
        await __reportMemory(cellId);
      } finally {
        __state.cellId = null;
      }
    },
  };
  // The project binding tracker project-state-runtime.ts:18 calls. A binding reaches the worktree
  // manifest only after promote(), so a private session value never leaks into the project.
  const __projectBindings = new Set();
  Object.defineProperty(globalThis, "__piNotebook", {
    value: {
      projectBindings: () => [...__projectBindings],
      promote: (names) => { for (const name of names) __projectBindings.add(name); },
      syncProjectBindings: (names) => {
        __projectBindings.clear();
        for (const name of names) __projectBindings.add(name);
      },
    },
    configurable: false,
  });
  Object.defineProperty(globalThis, ${JSON.stringify(NOTEBOOK_RUNTIME_GLOBAL)}, { value: __runtime, configurable: false });
  globalThis.tools = __tools;
  globalThis.ALL_TOOLS = [];
  globalThis.text = (value) => __emit([{ type: "input_text", text: __stringify(value) }]);
  globalThis.image = __image;
  globalThis.audio = __audio;
  globalThis.generatedImage = (value) => {
    if (!value || typeof value.image_url !== "string") throw new TypeError("generatedImage expects an image result");
    if (value.output_hint !== undefined && typeof value.output_hint !== "string") throw new TypeError("generatedImage output_hint must be a string when provided");
    __image(value.image_url);
    if (value.output_hint !== undefined) globalThis.text(value.output_hint);
  };
  globalThis.notify = (value) => {
    const text = __stringify(value);
    if (!text.trim()) throw new TypeError("notify expects non-empty text");
    if (!__state.cellId) throw new Error("notify called outside an active exec cell");
    __track(__post({ kind: "notify", cellId: __state.cellId, text }));
  };
  globalThis.yield_control = () => {
    if (!__state.cellId) throw new Error("yield_control called outside an active exec cell");
    __track(__post({ kind: "yield", cellId: __state.cellId }));
  };
  globalThis.exit = () => {
    const error = new Error("exit() ended the cell");
    error.name = ${JSON.stringify(NOTEBOOK_EXIT_NAME)};
    throw error;
  };
  globalThis.store = (key, value) => {
    if (typeof key !== "string") throw new TypeError("store key must be a string");
    const encoded = JSON.stringify(value);
    __state.store.set(key, encoded === undefined ? undefined : JSON.parse(encoded));
  };
  globalThis.load = (key) => {
    if (typeof key !== "string") throw new TypeError("load key must be a string");
    const value = __state.store.get(key);
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  };
}`;
}
