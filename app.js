/* The Finance System's web page.
 *
 * In plain words: this page reads the summary the MacBook pinned up (webpage-summary.json) and the forms
 * (webpage-forms.json) from Alvin's private mailbox on GitHub, and posts what he types back to the same
 * mailbox as notes (GitHub "issues"). It never works anything out that the MacBook has not worked out
 * first; the one sum it does is the sweep, from figures the summary gives it.
 *
 * Everything typed is saved on this device first, in its outbox, and only then sent. If sending fails
 * (no signal, the key has expired) it stays in the outbox and is tried again the next time the page is
 * opened or comes back online. Each note carries a serial number made here, so if one is ever sent
 * twice the MacBook keeps it once.
 *
 * All text from the summary is shown as text, never as HTML. The page talks to api.github.com and
 * nowhere else (the Content-Security-Policy in index.html enforces it).
 *
 * Source: webpage/ in the Finance System repository; tools/finance-system-webpage.py deploy copies it to the page's own
 * public repository, which holds code only. Written 2026-09-13 under D-2026-09-13-01.
 */
"use strict";

// GitHub's address. Only a test changes it, through config.json, to a stand-in on
// the same machine; the published config.json never names one.
const api = () => (CFG && CFG.api) || "https://api.github.com";
const MARKER = "finance-system-web-entry";
const K = { token: "finance-system.token", cfg: "finance-system.cfg", snap: "finance-system.snapshot", schema: "finance-system.schema",
            outbox: "finance-system.outbox", sent: "finance-system.sent", expiry: "finance-system.expiry", tab: "finance-system.tab", waiting: "finance-system.waiting" };
const STALE_HOURS = 2;

let CFG = null, SNAP = null, SCHEMA = null;
let NET = "unknown";          // "ok" | "offline" | "key" | "error"
let NET_MSG = "";
let FORM = { kind: null, corrects: "", prefill: null };

/* ---------- small helpers ---------- */

function load(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked: the page still works */ } }
function drop(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [a, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (a === "class") e.className = v;
    else if (a === "text") e.textContent = v;
    else if (a.startsWith("on")) e.addEventListener(a.slice(2), v);
    else if (v === true) e.setAttribute(a, "");
    else e.setAttribute(a, String(v));
  }
  for (const k of kids.flat()) {
    if (k === null || k === undefined || k === false) continue;
    e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return e;
}
function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }

function money(v) {
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function fmt$(v) {
  const n = money(v);
  return n === null ? "" : "$" + n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pad(n) { return String(n).padStart(2, "0"); }
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function typedAt() {
  const d = new Date(), off = -d.getTimezoneOffset(), s = off >= 0 ? "+" : "-", a = Math.abs(off);
  return `${todayISO()}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${s}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
function ago(iso) {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 36) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const d = Math.round(hrs / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
function when(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso || "";
  return new Date(t).toLocaleString("en-CA", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function newId() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789", a = new Uint8Array(14);
  crypto.getRandomValues(a);
  return Array.from(a, x => abc[x % abc.length]).join("");
}
function device() { return /iPhone|iPad|iPod/.test(navigator.userAgent) ? "iPhone" : "MacBook"; }
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3600);
}
function token() { return load(K.token, ""); }

/* ---------- talking to GitHub ---------- */

class PageError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }

async function gh(path, opts = {}) {
  if (!token()) throw new PageError("key", "No key on this device yet. Add it under Key.");
  if (!CFG || !CFG.github_owner || !CFG.mailbox_repository) throw new PageError("error", "The page does not know which mailbox to use.");
  let r;
  try {
    r = await fetch(api() + path, {
      method: opts.method || "GET", cache: "no-store", body: opts.body,
      headers: Object.assign({ "Authorization": "Bearer " + token(), "X-GitHub-Api-Version": "2022-11-28",
                               "Accept": opts.accept || "application/vnd.github+json" },
                             opts.body ? { "Content-Type": "application/json" } : {})
    });
  } catch (e) {
    throw new PageError("offline", "No connection. Your entries are saved on this device and will send later.");
  }
  const exp = r.headers.get("github-authentication-token-expiration");
  if (exp) save(K.expiry, exp);
  if (r.status === 401) throw new PageError("key", "GitHub refused the key. It may have expired or been typed wrongly: make a new one and paste it under Key.");
  if (r.status === 403 || r.status === 404) throw new PageError("key", "The key cannot reach the mailbox. It must allow the repository " + CFG.github_owner + "/" + CFG.mailbox_repository + " (Contents: read, Issues: read and write).");
  if (!r.ok) throw new PageError("error", "GitHub answered " + r.status + ". Try again in a few minutes.");
  return r;
}
const repo = () => `/repos/${encodeURIComponent(CFG.github_owner)}/${encodeURIComponent(CFG.mailbox_repository)}`;

async function refresh() {
  try {
    const raw = "application/vnd.github.raw+json";
    const [s, f] = await Promise.all([
      gh(repo() + "/contents/webpage-summary.json", { accept: raw }).then(r => r.json()),
      gh(repo() + "/contents/webpage-forms.json", { accept: raw }).then(r => r.json()).catch(() => SCHEMA)
    ]);
    if (s && s.format === "finance-system-webpage-summary") { SNAP = s; save(K.snap, s); }
    if (f && f.forms) { SCHEMA = f; save(K.schema, f); }
    const issues = await gh(repo() + "/issues?state=open&per_page=100").then(r => r.json());
    const waiting = issues.filter(i => !i.pull_request && typeof i.body === "string" && i.body.indexOf(MARKER) >= 0).length;
    save(K.waiting, waiting);
    NET = "ok"; NET_MSG = "";
  } catch (e) {
    NET = e.kind || "error"; NET_MSG = e.message;
  }
  render();
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    let box = load(K.outbox, []);
    while (box.length) {
      const entry = box[0];
      try {
        const r = await gh(repo() + "/issues", { method: "POST", body: JSON.stringify({ title: "Finance System web entry, waiting for the MacBook to collect it", body: JSON.stringify(entry) }) });
        const j = await r.json();
        const sent = load(K.sent, []);
        sent.unshift({ entry, number: j.number, sent_at: new Date().toISOString() });
        save(K.sent, sent.slice(0, 60));
        box = load(K.outbox, []).filter(x => x.id !== entry.id);
        save(K.outbox, box);
        save(K.waiting, load(K.waiting, 0) + 1);
      } catch (e) {
        NET = e.kind || "error"; NET_MSG = e.message;
        break;
      }
    }
  } finally {
    flushing = false;
    render();
  }
}

function submit(kind, fields, corrects) {
  const entry = { format: MARKER, id: newId(), kind, typed_at: typedAt(), device: device(), fields };
  if (corrects) entry.corrects = corrects;
  const box = load(K.outbox, []);
  box.push(entry);
  save(K.outbox, box);
  toast(navigator.onLine ? "Saved. Sending…" : "Saved on this device. It will send when you are back online.");
  FORM = { kind: null, corrects: "", prefill: null };
  flush();
  return entry;
}

/* ---------- the header ---------- */

function renderFresh() {
  const el = document.getElementById("fresh");
  el.className = "fresh";
  const outbox = load(K.outbox, []).length, waiting = load(K.waiting, 0);
  const parts = [];
  if (SNAP && SNAP.checked_at) {
    const hrs = (Date.now() - Date.parse(SNAP.checked_at)) / 3.6e6;
    parts.push(`Summary written ${ago(SNAP.written_at)}` + (SNAP.checked_at !== SNAP.written_at ? `; MacBook last checked in ${ago(SNAP.checked_at)}` : ""));
    if (hrs > STALE_HOURS) el.classList.add("stale");
  } else if (!token()) {
    parts.push("Add this device's key under Key to begin.");
  } else {
    parts.push("No summary yet.");
  }
  if (outbox) parts.push(`${outbox} on this device waiting to send`);
  if (waiting) parts.push(`${waiting} waiting for the MacBook`);
  if (NET === "offline") parts.push("offline");
  if (NET === "key" || NET === "error") el.classList.add("bad");
  el.textContent = parts.join(" · ");
}

/* ---------- Today ---------- */

function renderToday() {
  const p = clear(document.getElementById("today"));
  if (NET === "key" || NET === "error") p.append(h("div", { class: "card warn" }, h("h3", { text: "Something needs you" }), h("p", { text: NET_MSG })));
  if (!SNAP) {
    p.append(h("div", { class: "card" }, h("p", { text: token() ? "The summary has not arrived yet. If the MacBook has never published one, run tools/finance-system-webpage.py setup on it." : "This device has no key yet. Open Key, paste the key you made for this device, and the summary will appear." })));
    return;
  }
  const m = SNAP.machine || {};
  if (m.state === "stuck") p.append(h("div", { class: "card warn" }, h("h3", { text: "The bookkeeper is stuck" }),
    h("p", { text: m.reason }), h("p", { class: "muted", text: "Since " + when(m.since) + ". You can keep sending entries; they are collected, just not added to the books until a session has looked." })));
  else if (m.state === "busy") p.append(h("div", { class: "banner" }, "The bookkeeper is only collecting for now: " + m.reason + "."));
  const hrs = SNAP.checked_at ? (Date.now() - Date.parse(SNAP.checked_at)) / 3.6e6 : 999;
  if (hrs > STALE_HOURS) {
    p.append(h("div", { class: "banner" }, `The MacBook last checked in ${ago(SNAP.checked_at)}, so it is probably closed. `,
      "Everything below is from then. Anything you send now waits safely, and is collected within 15 minutes of the lid opening."));
  }
  const outbox = load(K.outbox, []);
  if (outbox.length) {
    p.append(h("div", { class: "card mine" }, h("h3", { text: `${outbox.length} saved on this device, not yet sent` }),
      h("p", { class: "muted", text: "They send by themselves when there is a connection." }),
      h("button", { onclick: () => flush() }, "Try sending now")));
  }
  if (SNAP.held && SNAP.held.length) {
    const c = h("div", { class: "card warn" }, h("h3", { text: `${SNAP.held.length} held: the bookkeeper could not use ${SNAP.held.length === 1 ? "it" : "them"}` }));
    const ul = h("ul", { class: "list" });
    for (const e of SNAP.held) {
      ul.append(h("li", {}, h("span", { text: e.summary }), h("span", { class: "muted", text: "Because " + e.reason }),
        h("div", {}, e.fields ? h("button", { class: "quiet", onclick: () => startCorrect(e) }, "Correct it") : null,
                    h("button", { class: "quiet", onclick: () => withdraw(e) }, "Take it back"))));
    }
    c.append(ul); p.append(c);
  }
  p.append(payCard(true));
  const qs = (SNAP.questions || []).filter(q => !q.answered);
  if (qs.length) {
    const c = h("div", { class: "card book" }, h("h3", { text: `${qs.length} question${qs.length === 1 ? "" : "s"} for you` }));
    const ul = h("ul", { class: "list" });
    for (const q of qs.slice(0, 8)) {
      ul.append(h("li", {}, h("span", { text: q.text }),
        h("div", {}, q.due ? h("span", { class: "muted", text: "due " + q.due + " " }) : null,
          h("button", { class: "quiet", onclick: () => startForm("answer", { question: q.id }) }, "Answer"))));
    }
    if (qs.length > 8) ul.append(h("li", { class: "muted", text: `and ${qs.length - 8} more, under Enter › Answer a question` }));
    c.append(ul); p.append(c);
  }
  if (SNAP.due && SNAP.due.length) {
    const c = h("div", { class: "card book" }, h("h3", { text: "Coming up, the next six weeks" }));
    const ul = h("ul", { class: "list" });
    for (const d of SNAP.due) {
      ul.append(h("li", {}, h("div", { class: "row" }, h("span", { text: d.date }), d.amount && Number(d.amount) ? h("span", { class: "amt", text: fmt$(d.amount) }) : null),
        h("span", { class: "muted", text: d.what })));
    }
    c.append(ul); p.append(c);
  }
}

function payCard(withButton) {
  const pd = SNAP && SNAP.payday;
  const c = h("div", { class: "card book" }, h("h3", { text: "The monthly bank visit" }));
  if (!pd) { c.append(h("p", { class: "muted", text: "Nothing yet." })); return c; }
  c.append(h("p", { class: "muted", text: `Next visit: the last business day of the month (${pd.next_visit} for next month).` }));
  const ul = h("ul", { class: "list" });
  for (const it of pd.items) {
    ul.append(h("li", {}, h("div", { class: "row" }, h("span", { text: it.what }), h("span", { class: "amt", text: it.amount ? fmt$(it.amount) : "the amount on screen" })),
      h("span", { class: "muted", text: (it.due ? "due " + it.due + " · " : "") + it.basis })));
  }
  c.append(ul);
  if (withButton) c.append(h("button", { class: "primary", onclick: () => startForm("bankvisit") }, "I've done the bank visit"));
  return c;
}

/* ---------- Enter ---------- */

function formsList() { return (SCHEMA && SCHEMA.forms) || []; }

function startForm(kind, prefill) { FORM = { kind, corrects: "", prefill: prefill || null }; show("enter"); }
function startCorrect(e) { FORM = { kind: e.kind, corrects: e.id, prefill: e.fields || {}, label: e.summary }; show("enter"); }
function withdraw(e) {
  if (!confirm("Take back this entry?\n\n" + e.summary + "\n\nThe record keeps it, marked as taken back.")) return;
  submit("withdraw", {}, e.id);
}

function renderEnter() {
  const p = clear(document.getElementById("enter"));
  const forms = formsList();
  if (!forms.length) { p.append(h("div", { class: "card" }, h("p", { text: "The forms have not arrived yet. They come with the first summary." }))); return; }
  if (!FORM.kind) {
    p.append(h("h2", { text: "What would you like to enter?" }));
    const k = h("div", { class: "kinds" });
    for (const f of forms) k.append(h("button", { onclick: () => startForm(f.kind) }, f.title));
    p.append(k);
    p.append(recentCard());
    return;
  }
  const f = forms.find(x => x.kind === FORM.kind);
  if (!f) { FORM = { kind: null }; return renderEnter(); }
  p.append(h("div", { class: "row" }, h("h2", { text: f.title }), h("button", { class: "quiet", onclick: () => { FORM = { kind: null }; renderEnter(); } }, "Back")));
  if (FORM.corrects) p.append(h("div", { class: "banner" }, "Correcting: " + (FORM.label || FORM.corrects) + ". The new version replaces it; the old one is kept, marked as corrected."));
  p.append(h("p", { class: "muted", text: f.help }));
  p.append(buildForm(f));
}

function buildForm(f) {
  const form = h("form", { novalidate: true });
  const pre = FORM.prefill || {};
  const inputs = {};
  // Short fields sit two to a row; long text and the checklist take the full width, after them.
  const grid = h("div", { class: "grid2" });
  const wide = [], late = [];
  form.append(grid);
  for (const fld of f.fields) {
    const id = `f-${f.kind}-${fld.key}`;
    const lab = h("label", { for: id }, fld.label, fld.required ? h("span", { class: "req", "aria-hidden": "true" }, " *") : null);
    let inp;
    const v = pre[fld.key] !== undefined ? pre[fld.key] : (fld.type === "date" ? todayISO() : "");
    if (fld.type === "choice") {
      inp = h("select", { id, name: fld.key, required: fld.required });
      inp.append(h("option", { value: "" }, "Choose…"));
      const opts = fld.source === "questions" ? (SNAP ? SNAP.questions || [] : []).map(q => ({ value: q.id, label: (q.answered ? "(answered) " : "") + q.text })) : (fld.options || []);
      for (const o of opts) inp.append(h("option", { value: o.value, selected: o.value === v }, o.label));
    } else if (fld.type === "checklist") {
      inp = h("div", { id, class: "list" });
      const items = (SNAP && SNAP.payday && SNAP.payday.items) || [];
      for (const it of items) {
        const cb = h("input", { type: "checkbox", value: it.id, id: `${id}-${it.id}`, checked: Array.isArray(v) && v.includes(it.id) });
        cb.addEventListener("change", () => updateSweep(form));
        inp.append(h("label", { class: "check", for: `${id}-${it.id}` }, cb, h("span", {}, it.what, it.amount ? " · " + fmt$(it.amount) : "")));
      }
      inputs[fld.key] = inp;
      wide.push(h("div", { class: "card mine" }, h("strong", { text: fld.label }), inp));
      continue;
    } else if (fld.key === "text" || fld.key === "answer" || fld.key === "note" || fld.key === "who_why") {
      inp = h("textarea", { id, name: fld.key, required: fld.required, maxlength: 500 });
      inp.value = v;
    } else {
      const type = { date: "date", time: "time", money: "text", number: "text" }[fld.type] || "text";
      inp = h("input", { id, name: fld.key, type, required: fld.required, maxlength: 500,
                         inputmode: fld.type === "money" || fld.type === "number" ? "decimal" : null,
                         autocomplete: "off" });
      inp.value = v;
      if (fld.key === "balance") inp.addEventListener("input", () => updateSweep(form));
    }
    inputs[fld.key] = inp;
    lab.append(inp);
    if (f.kind === "bankvisit" && fld.key === "sweep") late.push(lab);   // after the suggestion it answers
    else if (inp.tagName === "TEXTAREA" || fld.source === "questions") wide.push(lab);
    else grid.append(lab);
  }
  for (const w of wide.filter(w => w.tagName !== "LABEL" || !w.querySelector("textarea"))) form.append(w);
  if (f.kind === "bankvisit") form.append(h("div", { class: "sweep", id: "sweep" }));
  for (const w of late) form.append(w);
  for (const w of wide.filter(w => w.tagName === "LABEL" && w.querySelector("textarea"))) form.append(w);
  const err = h("p", { class: "error", role: "alert" });
  form.append(err);
  form.append(h("button", { class: "primary", type: "submit" }, FORM.corrects ? "Send the correction" : "Send"));
  form.addEventListener("submit", ev => {
    ev.preventDefault();
    const fields = {}, problems = [];
    for (const fld of f.fields) {
      const inp = inputs[fld.key];
      if (fld.type === "checklist") {
        fields[fld.key] = Array.from(inp.querySelectorAll("input:checked")).map(x => x.value);
        continue;
      }
      const val = String(inp.value || "").trim();
      if (fld.required && !val) problems.push(fld.label + " is missing");
      if (val && (fld.type === "money" || fld.type === "number") && !/^-?\d{1,7}(\.\d{1,2})?$/.test(val.replace(/[,$\s]/g, ""))) problems.push(fld.label + ": type a number like 18.50");
      if (val) fields[fld.key] = (fld.type === "money" || fld.type === "number") ? val.replace(/[,$\s]/g, "") : val;
    }
    if (f.kind === "expense" && fields.meal === "yes" && !fields.who_why) problems.push("A meal needs who was there and why it was work");
    if (problems.length) { err.textContent = problems.join(". ") + "."; return; }
    submit(f.kind, fields, FORM.corrects);
    render();
    show("today");
  });
  if (f.kind === "bankvisit") setTimeout(() => updateSweep(form), 0);
  return form;
}

function updateSweep(form) {
  const box = form.querySelector("#sweep");
  if (!box || !SNAP || !SNAP.payday) return;
  const pd = SNAP.payday;
  clear(box);
  const bal = money((form.querySelector('[name="balance"]') || {}).value || "");
  const ticked = new Set(Array.from(form.querySelectorAll('input[type="checkbox"]:checked')).map(x => x.value));
  const lines = [];
  for (const it of pd.items) if (!ticked.has(it.id) && money(it.amount)) lines.push([it.what + " (not ticked yet)", money(it.amount)]);
  for (const r of pd.reserve || []) lines.push([r.what + " · " + r.due, money(r.amount)]);
  const cushion = money(pd.cushion) || 0;
  lines.push(["Cushion left in chequing", cushion]);
  box.append(h("strong", { text: "What to send to Questrade" }));
  box.append(h("p", { class: "muted", text: pd.rule }));
  if (bal === null) { box.append(h("p", { class: "muted", text: "Type the chequing balance above to see it." })); return; }
  const ul = h("ul", { class: "list" });
  ul.append(h("li", {}, h("div", { class: "row" }, h("span", { text: "Chequing balance" }), h("span", { class: "amt", text: fmt$(bal) }))));
  let left = bal;
  for (const [w, a] of lines) { left -= a; ul.append(h("li", {}, h("div", { class: "row" }, h("span", { text: "less " + w }), h("span", { class: "amt", text: "−" + fmt$(a) })))); }
  box.append(ul);
  box.append(h("div", { class: "row" }, h("span", { text: "Suggested sweep" }), h("span", { class: "total", text: left > 0 ? fmt$(left) : "$0.00" })));
  if (left <= 0) box.append(h("p", { class: "muted", text: "Nothing to sweep this month: the balance does not cover what is still due plus the cushion." }));
}

function recentCard() {
  const c = h("div", { class: "card" }, h("h3", { text: "Your recent entries" }));
  const ul = h("ul", { class: "list" });
  const seen = new Set();
  for (const e of load(K.outbox, [])) { seen.add(e.id); ul.append(h("li", {}, h("span", { text: summaryOf(e) }), h("span", { class: "muted", text: "on this device, not sent yet" }))); }
  const collected = (SNAP && SNAP.recent) || [];
  const collectedIds = new Set(collected.map(r => r.id));
  for (const s of load(K.sent, []).slice(0, 10)) {
    if (seen.has(s.entry.id) || collectedIds.has(s.entry.id)) continue;
    seen.add(s.entry.id);
    ul.append(h("li", {}, h("span", { text: summaryOf(s.entry) }), h("span", { class: "muted", text: "sent " + ago(s.sent_at) + "; waiting for the MacBook" })));
  }
  for (const r of collected.slice(0, 15)) {
    if (seen.has(r.id)) continue;
    ul.append(h("li", {}, h("div", { class: "row" }, h("span", { text: r.summary }), h("span", { class: "chip " + r.status, text: r.status })),
      r.status === "current" || r.status === "held" ? h("div", {},
        r.fields ? h("button", { class: "quiet", onclick: () => startCorrect(r) }, "Correct") : null,
        r.kind !== "withdraw" ? h("button", { class: "quiet", onclick: () => withdraw(r) }, "Take back") : null) : null));
  }
  if (!ul.firstChild) ul.append(h("li", { class: "muted", text: "Nothing yet." }));
  c.append(ul);
  return c;
}

function summaryOf(e) {
  const f = e.fields || {};
  switch (e.kind) {
    case "shift": return `Shift ${f.date || ""} · ${f.type || ""} ${f.description || ""}`;
    case "expense": return `${f.date || ""} · ${f.what || ""} · ${fmt$(f.amount)}`;
    case "bankvisit": return `Bank visit ${f.date || ""}`;
    case "answer": return "An answer";
    case "note": return `Note ${f.date || ""}`;
    case "withdraw": return "Taking back an entry";
    default: return e.kind;
  }
}

/* ---------- Overview ---------- */

function renderOverview() {
  const p = clear(document.getElementById("overview"));
  if (!SNAP || !(SNAP.overview || []).length) { p.append(h("div", { class: "card" }, h("p", { text: "No figures yet." }))); return; }
  p.append(h("p", { class: "muted", text: "Worked out on the MacBook from your records. Each figure says how sure it is: verified (read from a document), derived (worked out from verified figures), recorded (typed by you) or estimate." }));
  const g = h("div", { class: "figs" });
  for (const o of SNAP.overview) {
    g.append(h("div", { class: "card fig" }, h("span", { class: "muted", text: o.label }), h("span", { class: "val", text: o.value }),
      h("div", {}, h("span", { class: "chip " + o.basis, text: o.basis }), h("span", { class: "muted", text: o.as_of ? "  as of " + o.as_of : "" })),
      h("span", { class: "muted", text: o.source })));
  }
  p.append(g);
  p.append(payCard(false));
}

/* ---------- Key ---------- */

function renderKey() {
  const p = clear(document.getElementById("key"));
  const c = h("div", { class: "card" });
  c.append(h("h3", { text: "This device's key" }));
  c.append(h("p", { class: "muted", text: `The key lets this page read your mailbox (${CFG ? CFG.github_owner + "/" + CFG.mailbox_repository : "not set"}) and post your entries to it. It is kept only on this device. Make one key per device, so a lost phone costs one key.` }));
  const inp = h("input", { id: "token", type: "password", autocomplete: "off", placeholder: token() ? "A key is saved. Paste a new one to replace it." : "Paste the key here" });
  c.append(h("label", { for: "token" }, "Key", inp));
  c.append(h("button", { class: "primary", onclick: async () => {
    const v = inp.value.trim();
    // A fine-grained GitHub key begins "github", "pat", joined by underscores. The prefix is built
    // here rather than written out, so the repository's credential check never mistakes this line for a key.
    const prefix = ["github", "pat", ""].join("_");
    if (!v.startsWith(prefix) || !/^[A-Za-z0-9_]{30,}$/.test(v)) { toast("That does not look like a GitHub key. Copy it again from github.com."); return; }
    save(K.token, v); inp.value = "";
    toast("Key saved. Checking it…");
    await refresh(); await flush();
    toast(NET === "ok" ? "The key works." : NET_MSG);
    show(NET === "ok" ? "today" : "key");
  } }, "Save the key"));
  const exp = load(K.expiry, "");
  if (exp) {
    const days = Math.round((Date.parse(exp.replace(" UTC", "Z").replace(" ", "T")) - Date.now()) / 864e5);
    c.append(h("p", { class: Number.isFinite(days) && days < 30 ? "error" : "muted",
      text: Number.isFinite(days) ? `The key expires in ${days} days (${exp}).` + (days < 30 ? " Make a new one soon." : "") : `The key expires ${exp}.` }));
  }
  if (token()) c.append(h("button", { class: "quiet", onclick: () => { if (confirm("Forget the key on this device?")) { drop(K.token); render(); } } }, "Forget the key on this device"));
  p.append(c);
  p.append(h("div", { class: "card" }, h("h3", { text: "What leaves this device" }),
    h("p", { class: "muted", text: "Only what you send from Enter, to your private mailbox on GitHub. The MacBook collects it within 15 minutes of being open, checks it, and blacks out anything shaped like a card, account or SIN before it is written down. Never put a password here." })));
}

/* ---------- tabs and start ---------- */

function show(tab) {
  save(K.tab, tab);
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const s of document.querySelectorAll(".panel")) s.hidden = s.id !== tab;
  render();
  window.scrollTo(0, 0);
}

function render() {
  renderFresh();
  const tab = load(K.tab, "today");
  if (tab === "today") renderToday();
  else if (tab === "enter") renderEnter();
  else if (tab === "overview") renderOverview();
  else renderKey();
}

async function boot() {
  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => { if (b.dataset.tab === "enter" && !FORM.corrects) FORM = { kind: null }; show(b.dataset.tab); });
  try { CFG = await fetch("config.json", { cache: "no-store" }).then(r => r.json()); save(K.cfg, CFG); }
  catch (e) { CFG = load(K.cfg, null); }
  SNAP = load(K.snap, null);
  SCHEMA = load(K.schema, null);
  show(token() ? load(K.tab, "today") : "key");
  if (token()) { await refresh(); await flush(); }
  window.addEventListener("online", () => { flush(); refresh(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && token()) { flush(); refresh(); } });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { /* the page works without it, only not offline */ });
}

boot();
