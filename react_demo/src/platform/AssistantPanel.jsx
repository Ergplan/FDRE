// The embedded assistant: chat and RealTalk voice over one server-authorised tool registry.
// Mutations arrive as proposals the user confirms (one idempotency key per proposal, so a
// retried click never executes twice). Voice: in recorded mode the browser's own speech
// recognition and synthesis carry the audio and only final transcripts reach the server; in
// live mode the browser talks to the provider over WebRTC with a short-lived grant minted by
// the server and relays tool calls and captions back here. Audio is never sent to the platform.
import React, { useEffect, useRef, useState } from "react";
import { platformApi } from "./api";

const newKey = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`);

export default function AssistantPanel({ org, tenderId, scenario }) {
  const can = (p) => Boolean(org?.permissions?.includes(p));
  const base = org ? `/orgs/${org.id}/assistant` : null;
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [actions, setActions] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tools, setTools] = useState([]);
  const [voice, setVoice] = useState({ status: "off", session: null, interim: "", speaking: false, note: "" });
  const keys = useRef({});
  const recognition = useRef(null);
  const peer = useRef(null);
  const audioEl = useRef(null);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  useEffect(() => {
    if (!base) return;
    setConversation(null); setMessages([]); setActions([]);
    platformApi(`${base}/tools`).then(setTools).catch(() => {});
    platformApi(`${base}/conversations${tenderId ? `?tender_id=${tenderId}` : ""}`).then(async (list) => {
      const chat = list.find((c) => c.channel === "chat");
      if (chat) { setConversation(chat); setMessages(await platformApi(`${base}/conversations/${chat.id}/messages`)); setActions((await platformApi(`${base}/conversations/${chat.id}/actions?status=proposed`))); }
    }).catch((e) => setError(e.message));
  }, [org?.id, tenderId]);

  async function ensureConversation(channel = "chat") {
    if (conversation && channel === "chat") return conversation;
    const c = await platformApi(`${base}/conversations`, { method: "POST", body: { tender_id: tenderId || null, channel } });
    if (channel === "chat") setConversation(c);
    return c;
  }

  function absorb(result) {
    setMessages((prev) => [...prev, ...result.messages]);
    setConversation((c) => (c ? { ...c, knowledge_version: result.knowledge_version } : c));
    if (result.actions?.length) setActions((prev) => [...prev, ...result.actions]);
    return result;
  }

  async function send(text) {
    const t = (text ?? input).trim();
    if (!t) return;
    setBusy(true); setError("");
    try {
      const c = await ensureConversation();
      const out = await platformApi(`${base}/conversations/${c.id}/messages`, { method: "POST", body: { text: t, scenario_id: scenario?.id || null } });
      absorb(out); setInput("");
      return out;
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function decide(action, verb) {
    setError("");
    try {
      if (verb === "confirm") keys.current[action.id] = keys.current[action.id] || newKey();
      const out = await platformApi(`${base}/actions/${action.id}/${verb}`, { method: "POST", headers: verb === "confirm" ? { "Idempotency-Key": keys.current[action.id] } : {} });
      setActions((prev) => prev.map((a) => (a.id === action.id ? out : a)));
      if (out.status === "executed") speak(`Done: ${action.preview}`);
    } catch (e) { setError(e.message); }
  }

  // ---------------------------------------------------------------- voice (recorded mode)
  function speak(text) {
    if (!window.speechSynthesis || voiceRef.current.status === "off") return;
    const u = new SpeechSynthesisUtterance(text.replace(/\(recorded assistant.*?\)/g, "").slice(0, 600));
    u.onstart = () => setVoice((v) => ({ ...v, speaking: true }));
    u.onend = () => setVoice((v) => ({ ...v, speaking: false }));
    window.speechSynthesis.speak(u);
  }

  async function voiceEvent(session, event) {
    try {
      return await platformApi(`${base}/voice/sessions/${session.id}/events`, { method: "POST", body: event });
    } catch (e) {
      if (e.status === 422 && /expired|ended/.test(e.message)) {
        const next = await platformApi(`${base}/voice/sessions`, { method: "POST", body: { reconnect_of: session.id } });
        setVoice((v) => ({ ...v, session: next, note: `reconnected (${next.reconnects})` }));
        return platformApi(`${base}/voice/sessions/${next.id}/events`, { method: "POST", body: event });
      }
      throw e;
    }
  }

  async function startVoice() {
    setError("");
    try {
      const session = await platformApi(`${base}/voice/sessions`, { method: "POST", body: { tender_id: tenderId || null, conversation_id: conversation?.id || null } });
      setVoice({ status: "on", session, interim: "", speaking: false, note: session.fallback_reason || "" });
      if (session.mode === "live" && session.grant) return startLive(session);
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { setVoice((v) => ({ ...v, note: "This browser has no speech recognition; type instead (text fallback)." })); return; }
      const rec = new SR();
      rec.continuous = true; rec.interimResults = true; rec.lang = "en-IN";
      rec.onresult = async (ev) => {
        let interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
          const r = ev.results[i];
          if (r.isFinal) {
            const text = r[0].transcript.trim();
            if (window.speechSynthesis?.speaking) { window.speechSynthesis.cancel(); voiceEvent(session, { type: "interrupted" }).catch(() => {}); }
            setVoice((v) => ({ ...v, interim: "" }));
            const out = await voiceEvent(voiceRef.current.session || session, { type: "command", text, scenario_id: scenario?.id || null }).catch((e) => setError(e.message));
            if (out?.messages) { absorb(out); const last = [...out.messages].reverse().find((m) => m.role === "assistant" && m.content); if (last) speak(last.content); }
          } else interim += r[0].transcript;
        }
        if (interim) { if (window.speechSynthesis?.speaking) window.speechSynthesis.cancel(); setVoice((v) => ({ ...v, interim })); }
      };
      rec.onerror = (e) => setVoice((v) => ({ ...v, note: `recognition ${e.error}; retrying` }));
      rec.onend = () => { if (voiceRef.current.status === "on" && recognition.current === rec) { try { rec.start(); } catch { /* restarted by the browser */ } } };
      recognition.current = rec;
      rec.start();
    } catch (e) { setError(e.message); setVoice({ status: "off", session: null, interim: "", speaking: false, note: "" }); }
  }

  // ----------------------------------------------------------------- voice (live mode)
  // Built against the provider's documented WebRTC flow; it needs a provider key on the server and
  // a route to the provider, neither of which exists in the build environment, so it is untested live.
  async function startLive(session) {
    const g = session.grant;
    const pc = new RTCPeerConnection();
    peer.current = pc;
    pc.ontrack = (e) => { if (audioEl.current) audioEl.current.srcObject = e.streams[0]; };
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    mic.getTracks().forEach((t) => pc.addTrack(t, mic));
    const dc = pc.createDataChannel("oai-events");
    dc.onmessage = async (msg) => {
      let ev; try { ev = JSON.parse(msg.data); } catch { return; }
      if (ev.type === "conversation.item.input_audio_transcription.completed" && ev.transcript) { setMessages((p) => [...p, { id: ev.item_id, role: "user", channel: "voice", content: ev.transcript }]); voiceEvent(session, { type: "caption.user", text: ev.transcript }).catch(() => {}); }
      if (ev.type === "response.audio_transcript.done" && ev.transcript) { setMessages((p) => [...p, { id: ev.response_id, role: "assistant", channel: "voice", content: ev.transcript, provider: "live" }]); voiceEvent(session, { type: "caption.assistant", text: ev.transcript }).catch(() => {}); }
      if (ev.type === "input_audio_buffer.speech_started") voiceEvent(session, { type: "interrupted" }).catch(() => {});
      if (ev.type === "response.function_call_arguments.done") {
        const out = await voiceEvent(session, { type: "tool_call", name: ev.name, arguments: ev.arguments, call_id: ev.call_id }).catch((e) => ({ output: { error: "failed", message: e.message } }));
        if (out?.actions?.length) setActions((p) => [...p, ...out.actions]);
        dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify(out.output) } }));
        dc.send(JSON.stringify({ type: "response.create" }));
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await fetch(`${g.base_url}/realtime?model=${encodeURIComponent(g.model)}`, { method: "POST", body: offer.sdp, headers: { Authorization: `Bearer ${g.client_secret}`, "Content-Type": "application/sdp" } });
    if (!res.ok) throw new Error(`voice provider refused the session (${res.status}); use text`);
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    pc.onconnectionstatechange = () => { if (["failed", "disconnected"].includes(pc.connectionState) && voiceRef.current.status === "on") { setVoice((v) => ({ ...v, note: "connection lost; reconnecting" })); stopVoice(false).then(() => startVoice()); } };
  }

  async function stopVoice(end = true) {
    const s = voiceRef.current.session;
    recognition.current?.stop(); recognition.current = null;
    window.speechSynthesis?.cancel();
    peer.current?.close(); peer.current = null;
    setVoice({ status: "off", session: null, interim: "", speaking: false, note: "" });
    if (end && s) await platformApi(`${base}/voice/sessions/${s.id}/end`, { method: "POST" }).catch(() => {});
  }
  useEffect(() => () => { recognition.current?.stop(); peer.current?.close(); window.speechSynthesis?.cancel(); }, []);

  if (!org) return null;
  const pending = actions.filter((a) => a.status === "proposed");
  return (
    <section className="assistant">
      <div className="req-head">
        <h2>Assistant</h2>
        {conversation && <span className="chip">knowledge {conversation.knowledge_version?.slice(0, 8) || "—"}</span>}
        <span className="chip" title="Tools the server allows for your role">{tools.length} tools · {tools.filter((t) => t.mutating).length} need confirmation</span>
        {voice.status === "off" ? <button className="secondary" onClick={startVoice}>Start voice</button> : <button className="secondary" onClick={() => stopVoice(true)}>Stop voice{voice.session ? ` (${voice.session.mode})` : ""}</button>}
        {voice.speaking && <button className="link" onClick={() => { window.speechSynthesis?.cancel(); voiceEvent(voice.session, { type: "interrupted" }).catch(() => {}); }}>interrupt</button>}
      </div>
      <p className="note">Answers come from the platform's own data through server-authorised tools. Changes are proposed here and happen only when you confirm. Audio goes to the voice provider or stays in your browser; the platform stores captions and tool calls only.</p>
      {voice.status === "on" && <div className="alert ok">Voice {voice.session?.mode} · {voice.note || "listening"} {voice.interim && <em>“{voice.interim}”</em>}</div>}
      {error && <div className="alert">{error}</div>}
      <audio ref={audioEl} autoPlay />
      <ul className="chat">
        {messages.map((m) => (
          <li key={m.id} className={`msg ${m.role}`}>
            {m.role === "tool" ? <details><summary>tool {m.tool_name}</summary><pre className="mono">{m.content?.slice(0, 2000)}</pre></details> : <>
              <div>{m.content}{m.tool_calls?.length > 0 && <small className="note"> → {m.tool_calls.map((t) => t.name).join(", ")}</small>}</div>
              <small className="mono">{m.channel}{m.provider ? ` · ${m.provider}` : ""}{m.knowledge_version ? ` · k ${m.knowledge_version.slice(0, 8)}` : ""}</small>
            </>}
          </li>
        ))}
        {messages.length === 0 && <li className="note">Try: “summarise the tender”, “list scenarios”, “create a scenario called Case B copying &lt;scenario id&gt;”, “launch a fixed tariff run at 4.2”, “comparable awards for 200 MW fdre”.</li>}
      </ul>
      {pending.length > 0 && (
        <div className="proposals">
          <h4>Proposed actions (nothing has changed yet)</h4>
          {pending.map((a) => (
            <div key={a.id} className="proposal">
              <span className="chip">{a.tool}</span> {a.preview} <small className="mono">expires {a.expires_at.slice(11, 16)}</small>
              <button className="primary" onClick={() => decide(a, "confirm")}>Confirm</button>
              <button className="link" onClick={() => decide(a, "reject")}>Reject</button>
            </div>
          ))}
        </div>
      )}
      {actions.filter((a) => a.status !== "proposed").slice(-3).map((a) => <p key={a.id} className="note"><span className={`chip ${a.status === "executed" ? "accepted" : "warn"}`}>{a.status}</span> {a.tool}: {a.error || JSON.stringify(a.result)}</p>)}
      <div className="composer-row">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={tenderId ? "Ask about this tender or ask for an action…" : "Select a tender for tender-specific answers, or ask generally…"} onKeyDown={(e) => { if (e.key === "Enter") send(); }} disabled={busy} />
        <button className="primary" onClick={() => send()} disabled={busy || !input.trim()}>{busy ? "…" : "Send"}</button>
      </div>
      {!can("run.launch") && <p className="note">Your role can read through the assistant but cannot launch runs or edit scenarios.</p>}
    </section>
  );
}
