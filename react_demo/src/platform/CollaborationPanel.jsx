// Tender chat, threaded comments on objects, @mentions, review decisions and the open tasks.
import React, { useEffect, useRef, useState } from "react";
import { platformApi } from "./api";

export default function CollaborationPanel({ org, tenderId, me, objectType = null, objectId = null, compact = false }) {
  const can = (p) => Boolean(org?.permissions?.includes(p));
  const [comments, setComments] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [body, setBody] = useState("");
  const [kind, setKind] = useState(objectType ? "comment" : "chat");
  const [decision, setDecision] = useState("approved");
  const [replyTo, setReplyTo] = useState(null);
  const [message, setMessage] = useState("");
  const since = useRef(null);

  async function load(full = true) {
    if (!org || !tenderId) return;
    const q = objectType ? `?object_type=${objectType}&object_id=${objectId}` : "";
    const list = await platformApi(`/orgs/${org.id}/tenders/${tenderId}/comments${q}`);
    setComments(list);
    if (list.length) since.current = list[list.length - 1].created_at;
    if (full) setTasks(await platformApi(`/orgs/${org.id}/tasks?tender_id=${tenderId}&mine=true`));
  }
  useEffect(() => { load().catch((e) => setMessage(e.message)); const t = window.setInterval(() => load(false).catch(() => {}), 5000); return () => window.clearInterval(t); }, [org?.id, tenderId, objectType, objectId]);

  async function send() {
    if (!body.trim()) return;
    try {
      await platformApi(`/orgs/${org.id}/tenders/${tenderId}/comments`, { method: "POST", body: { body, kind, object_type: objectType, object_id: objectId, parent_id: replyTo?.id || null, decision: kind === "decision" ? decision : null } });
      setBody(""); setReplyTo(null); await load();
    } catch (e) { setMessage(e.message); }
  }
  const roots = comments.filter((c) => !c.parent_id);
  const children = (id) => comments.filter((c) => c.parent_id === id);
  const Item = ({ c, depth }) => (
    <li style={{ marginLeft: depth * 16 }} className={`comment kind-${c.kind}${c.deleted ? " deleted" : ""}`}>
      <small className="mono">{String(c.created_at).slice(0, 16).replace("T", " ")}</small> <strong>{c.author || c.created_by?.slice(0, 8)}</strong> {c.kind === "decision" && <span className={`chip ${c.decision}`}>{c.decision}</span>} {c.object_type && !objectType && <small className="chip">{c.object_type} {c.object_id?.slice(0, 8)}</small>}
      <div>{c.deleted ? <em>deleted</em> : c.body}</div>
      {!c.deleted && can("comment.write") && <button className="link" onClick={() => setReplyTo(c)}>reply</button>}
      {!c.deleted && (c.created_by === me.user_id || can("members.manage")) && <button className="link" onClick={() => platformApi(`/orgs/${org.id}/comments/${c.id}/delete`, { method: "POST" }).then(() => load())}>delete</button>}
      <ul>{children(c.id).map((k) => <Item key={k.id} c={k} depth={depth + 1} />)}</ul>
    </li>
  );
  if (!tenderId) return null;
  return (
    <section className={`collab${compact ? " compact" : ""}`}>
      {!compact && <h3>{objectType ? `Comments on ${objectType}` : "Tender chat"}</h3>}
      {message && <div className="alert">{message}</div>}
      <ul className="comments">{roots.map((c) => <Item key={c.id} c={c} depth={0} />)}{roots.length === 0 && <li className="note">No messages yet.</li>}</ul>
      {can("comment.write") && (
        <div className="composer">
          {replyTo && <small>replying to {replyTo.author}: “{replyTo.body.slice(0, 60)}” <button className="link" onClick={() => setReplyTo(null)}>cancel</button></small>}
          <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message… use @email to mention a tender member" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
          <div className="composer-row">
            <select value={kind} onChange={(e) => setKind(e.target.value)}><option value="chat">chat</option><option value="comment">comment</option>{(can("bid.approve") || can("finance.review")) && <option value="decision">decision</option>}</select>
            {kind === "decision" && <select value={decision} onChange={(e) => setDecision(e.target.value)}><option value="approved">approved</option><option value="changes_requested">changes requested</option><option value="rejected">rejected</option></select>}
            <button className="primary" onClick={send}>Send</button>
          </div>
        </div>
      )}
      {!compact && tasks.length > 0 && <div className="my-tasks"><h4>My open tasks</h4><ul>{tasks.map((t) => <li key={t.id}><span className="chip">{t.kind}</span> {t.title} <button className="link" onClick={() => platformApi(`/orgs/${org.id}/tasks/${t.id}/complete`, { method: "POST", body: { status: "done" } }).then(() => load())}>done</button></li>)}</ul></div>}
    </section>
  );
}
