const element = (id) => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem("pi-voice-token");
if (token) sessionStorage.setItem("pi-voice-token", token);
history.replaceState(null, "", location.pathname);
let socket, audio, microphone, processor, nextAudio = 0;
let owned = false, muted = false, dictating = false, active = false, connected = false, closing = false;
let pending = false, transcribing = false, voiceStatus = "off";
const fail = (message) => { element("error").textContent = message; };
function render() {
  document.body.dataset.connected = String(connected);
  element("connection").textContent = connected ? "Connected to Pi" : "Reconnecting…";
  element("start").hidden = (active && owned) || dictating || transcribing;
  element("start").disabled = !connected || pending;
  element("start").textContent = active ? "Continue here" : pending ? "Starting…" : "Start voice";
  element("mute").hidden = !active || !owned;
  element("mute").textContent = muted ? "Unmute" : "Mute";
  element("stop").hidden = (!active && !pending) || dictating || transcribing;
  element("mute").disabled = element("stop").disabled = !connected;
  element("dictate").hidden = dictating || transcribing;
  element("dictate").disabled = !connected || active || pending;
  element("finish").hidden = !dictating;
  element("finish").disabled = pending || !connected;
  element("cancel").hidden = !dictating && !transcribing;
  element("send").disabled = !connected || !element("draft").value.trim();
  element("level").hidden = !microphone || muted || transcribing;
  element("draft-status").hidden = !dictating && !transcribing;
  element("draft-status").textContent = transcribing ? "Transcribing… Your draft will appear here." : pending ? "Connecting microphone…" : "Recording · Finish to review your draft";
  const titles = {listening:"Listening",speaking:"Pi is speaking",responding:"Pi is thinking",connecting:"Connecting voice…","preparing context":"Preparing your conversation…","refreshing context":"Refreshing the conversation…",reconnecting:"Reconnecting voice…"};
  element("status").textContent = active ? muted ? "Microphone muted" : titles[voiceStatus] || "Voice connected" : dictating ? "Dictating a draft" : transcribing ? "Turning speech into text…" : pending ? "Starting voice…" : "Ready when you are";
  element("hint").textContent = active ? owned ? "Speak naturally. Pi can keep working while you talk." : "Voice is open on another device. Continue here to move the microphone." : dictating || transcribing ? "Review and edit your words before sending them to Pi." : "Talk to the same Pi session running on your computer.";
}
const send = (message) => {
  if (socket?.readyState !== WebSocket.OPEN) throw new Error("Pi is disconnected. Wait for reconnection.");
  socket.send(JSON.stringify(message));
};
async function capture() {
  if (microphone) return;
  audio = new AudioContext({ sampleRate: 24000 }); await audio.resume();
  try {
    microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    await audio.audioWorklet.addModule("/audio-worklet.js");
    processor = new AudioWorkletNode(audio, "voice-capture");
    const source = audio.createMediaStreamSource(microphone); source.connect(processor);
    const silent = audio.createGain(); silent.gain.value = 0; processor.connect(silent).connect(audio.destination);
    processor.port.onmessage = ({ data }) => {
      const samples = new DataView(data); let peak = 0;
      for (let at = 0; at < data.byteLength; at += 2) peak = Math.max(peak, Math.abs(samples.getInt16(at, true)) / 32768);
      const level = muted ? 0 : Math.min(100, Math.round(Math.sqrt(peak) * 100));
      element("level-fill").style.width = `${level}%`; element("level").setAttribute("aria-valuenow", String(level));
      if ((owned || dictating) && !muted && !transcribing && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 128 * 1024) socket.send(data);
    };
  } catch (error) { await release(); throw error; }
}
async function release() {
  microphone?.getTracks().forEach((track) => track.stop()); microphone = undefined; processor?.disconnect(); processor = undefined;
  const previous = audio; audio = undefined; nextAudio = 0;
  await previous?.close();
}
function play(data) {
  if (!audio || !owned || dictating || transcribing) return;
  const pcm = new DataView(data); const buffer = audio.createBuffer(1, data.byteLength / 2, 24000); const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.getInt16(i * 2, true) / 32768;
  const source = audio.createBufferSource(); source.buffer = buffer; source.connect(audio.destination);
  if (nextAudio > audio.currentTime + 2) return;
  nextAudio = Math.max(audio.currentTime, nextAudio); source.start(nextAudio); nextAudio += buffer.duration;
}
function message(text, role) {
  element("empty").hidden = true;
  const article = document.createElement("article"); article.dataset.role = role;
  const label = document.createElement("h2"); label.textContent = role === "user" ? "You" : "Pi";
  const content = document.createElement("p"); content.textContent = text;
  article.append(label, content); element("messages").append(article);
}
function connect() {
  if (!token) { element("connection").textContent = "Link required"; fail("Open the complete phone link shown by Pi."); return; }
  socket = new WebSocket(`wss://${location.host}/socket`, ["pi-voice", token]); socket.binaryType = "arraybuffer";
  socket.onopen = () => { connected = true; fail(""); render(); };
  socket.onmessage = async ({ data }) => {
    if (data instanceof ArrayBuffer) { play(data); return; }
    const update = JSON.parse(data);
    if (update.type === "state") {
      const lost = owned && !update.owner;
      owned = update.owner; muted = update.muted; active = update.active; voiceStatus = update.status;
      if (active && owned) pending = false;
      microphone?.getTracks().forEach((track) => { track.enabled = !muted || dictating; });
      if (lost || (!owned && !active && !pending)) { dictating = false; transcribing = false; await release(); }
    } else if (update.type === "error") {
      fail(update.message); pending = false;
      if (!owned) { dictating = false; transcribing = false; await release(); }
    } else if (update.type === "dictation") {
      pending = update.status !== "listening" && update.status !== "transcribing";
      transcribing = update.status === "transcribing";
    } else if (update.type === "draft") {
      element("draft").value += `${element("draft").value ? "\n" : ""}${update.text}`;
      dictating = false; transcribing = false; pending = false; element("draft").focus();
    } else if (update.type === "message") message(update.text, "assistant");
    render();
  };
  socket.onclose = async () => { connected = false; owned = false; active = false; pending = false; dictating = false; transcribing = false; await release(); render(); if (!closing) setTimeout(connect, 2000); };
  socket.onerror = () => fail("Could not connect. Check this computer’s certificate and your network connection.");
}
const action = (id, fn) => { element(id).onclick = () => { fail(""); Promise.resolve().then(fn).catch(async (error) => { fail(error.message); pending = false; if (!owned) { dictating = false; transcribing = false; await release(); } }).finally(render); }; };
action("start", async () => { pending = true; render(); await capture(); send({ type: "start" }); });
action("mute", () => send({ type: "mute" }));
async function stop() { send({ type: "stop" }); owned = false; active = false; dictating = false; transcribing = false; pending = false; await release(); }
action("stop", stop); action("cancel", stop);
action("dictate", async () => { dictating = true; pending = true; muted = false; render(); await capture(); send({ type: "dictate" }); });
action("finish", async () => { send({ type: "finish_dictation" }); dictating = false; transcribing = true; await release(); });
action("send", () => { const text = element("draft").value.trim(); if (text) { send({ type: "text", text }); message(text, "user"); element("draft").value = ""; } });
element("draft").addEventListener("input", render);
window.addEventListener("pagehide", () => { closing = true; microphone?.getTracks().forEach((track) => track.stop()); socket?.close(); });
connect();
