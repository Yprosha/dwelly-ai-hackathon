// Case Lab UI. Simple: what a reviewer reads, after Sophie Lab's simple view. Full: everything technical.
// Routes: #/simple/<run>/<case> · #/full/<run>/<case>/<trace|simulator|judge|compare> · #/full/new · #/full/settings/<file>
const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = (n) => `$${(n ?? 0).toFixed(2)}`;
const dur = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
const when = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const day = (ts) => new Date(ts.replace(" ", "T") + "Z").toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const kfmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);
const tone = (r) => (r == null ? "" : r >= 90 ? "ok" : r >= 50 ? "meh" : "bad");
const caseNo = (key) => key.split("-").pop();
const isNote = (channel) => /note|update|hold/i.test(channel);

const ICON = {
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  sent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8"/><path d="m3 7 9 6 9-6"/><path d="m16 19 2 2 4-4"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 4 14h7l-1 7 9-11h-7z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  clip: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/></svg>',
};

// Markdown for model-written text. Raw HTML in it is shown as text, never rendered.
if (window.marked) marked.use({ renderer: { html: ({ text }) => esc(text) } });
const md = (t) => (window.marked ? marked.parse(String(t ?? ""), { breaks: true }) : `<p>${esc(t).replace(/\n/g, "<br>")}</p>`);
const firstLine = (t) => String(t ?? "").split("\n").map((l) => l.replace(/[#*_>`-]+/g, "").trim()).find(Boolean) ?? "";

async function api(path, opts) {
  const r = await fetch(path, opts);
  const isJson = (r.headers.get("content-type") || "").includes("json");
  const body = isJson ? await r.json() : await r.text();
  if (!r.ok) throw new Error((isJson && body.error) || body || r.statusText);
  return body;
}

let poll, routeToken = 0, titles;
const results = new Map(); // "<run>/<case>" -> finished result
const mailbox = { side: "run", filter: "all" }; // kept across claims

window.addEventListener("hashchange", route);
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select") || !["ArrowDown", "ArrowUp", "j", "k"].includes(e.key)) return;
  const links = [...document.querySelectorAll(".claims .claim, .keys a")];
  const i = links.findIndex((a) => a.classList.contains("on")) + (e.key === "ArrowDown" || e.key === "j" ? 1 : -1);
  if (links[i]) { e.preventDefault(); location.hash = links[i].getAttribute("href"); }
});
route();

async function route() {
  clearTimeout(poll);
  const token = ++routeToken;
  const [mode = "simple", a, b, c, ...rest] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  try {
    titles ??= Object.fromEntries((await api("/api/cases")).cases.map((x) => [x.key, x.title]));
    if (mode === "full" && a === "new") return await renderNew();
    if (mode === "full" && a === "settings") return await renderSettings([b, c, ...rest].filter(Boolean).join("/"));
    const runs = await api("/api/runs");
    if (!runs.length) {
      app.innerHTML = `<div class="empty"><b>No runs yet</b><span>Start a run to watch the agent work through claims.</span><a class="btn primary" href="#/full/new">Start a run</a></div>`;
      return;
    }
    const run = await api(`/api/runs/${encodeURIComponent(a || runs[0].id)}`);
    const keys = Object.keys(run.cases);
    const key = run.cases[b] ? b : keys.find((x) => ["done", "error"].includes(run.cases[x].status)) || keys[0];
    if (mode === "full") await renderFull(runs, run, key, c || "trace");
    else await renderSimple(runs, run, key, c === "chat" ? "chat" : "emails");
    if (run.status === "running") poll = setTimeout(() => refresh(mode, run.id, key, token), 4000);
  } catch (e) {
    app.innerHTML = `<div class="empty"><b>Something went wrong</b><span>${esc(e.message)}</span></div>`;
  }
}

// Live runs: refresh the list and score; redraw the claim only when its own status changes.
async function refresh(mode, id, key, token) {
  if (token !== routeToken) return;
  const run = await api(`/api/runs/${encodeURIComponent(id)}`);
  if (token !== routeToken) return;
  document.querySelector(".score").innerHTML = mode === "full" ? scoreFull(run) : scoreSimple(run);
  const list = document.querySelector(mode === "full" ? ".keys" : ".claims");
  const tab = location.hash.split("/")[4];
  list.innerHTML = mode === "full" ? keyRows(run, key, tab || "trace") : claimRows(run, key, tab || "emails");
  const pane = document.getElementById("pane");
  if (pane && pane.dataset.status !== run.cases[key]?.status) route();
  else if (run.status === "running") poll = setTimeout(() => refresh(mode, id, key, token), 4000);
}

function header(runs, run, mode, key) {
  return `<div class="head">
    <span class="crumb">Case Lab</span>
    <select class="runsel" id="runsel" aria-label="Run">${runs.map((r) => `<option value="${esc(r.id)}" ${r.id === run.id ? "selected" : ""}>${esc(r.label)} · ${when(r.createdAt)}${r.status === "running" ? " · running" : ""}</option>`).join("")}</select>
    <nav class="toggle" aria-label="View"><a href="#/simple/${run.id}/${key}" class="${mode === "simple" ? "on" : ""}">Simple</a><a href="#/full/${run.id}/${key}" class="${mode === "full" ? "on" : ""}">Full</a></nav>
  </div>`;
}
const bindRunSelect = (mode) => { document.getElementById("runsel").onchange = (e) => { location.hash = `#/${mode}/${e.target.value}`; }; };

// The two headline metrics. Escalation: the judge's verdict on the agent's first action against the claim's
// "Next action at escalation". End to end: the judge's verdict on the whole replay with the simulated parties.
// Runs judged before that verdict existed fall back to a derived one: escalation matched, every broker action
// covered, no violations.
const e2eOf = (s) => s.e2e ?? (s.firstAction ? s.firstAction === "match" && s.acts[0] === s.acts[1] && !s.violations : undefined);
const e2eVerdict = (j) => (j.end_to_end ? { ok: j.end_to_end.verdict === "correct", reason: j.end_to_end.reason }
  : { ok: j.first_action.verdict === "match" && j.acts.every((a) => a.covered) && !j.violations.length && !j.extras.some((x) => x.problem), reason: "Derived from the other rows: this run's judge gave no end-to-end verdict." });
const cardLabel = (s) => ({ none: "hidden", record: "record only", full: "shown" })[s.caseCard ?? "full"];

function counts(run) {
  const cs = Object.values(run.cases);
  const judged = cs.filter((c) => c.firstAction);
  const fin = cs.filter((c) => c.status === "done" || c.status === "error");
  const [cov, tot] = judged.reduce((t, c) => [t[0] + c.acts[0], t[1] + c.acts[1]], [0, 0]);
  return { cs, judged, fin, cov, tot, e2e: judged.filter(e2eOf).length, derived: judged.some((c) => c.e2e === undefined) };
}
const stat = (label, a, b) => { const r = pct(a, b); return `<span>${label}<b class="${tone(r)}">${r == null ? "—" : r + "%"}</b><span class="n">${a}/${b}</span></span>`; };

function scoreSimple(run) {
  const { cs, judged, fin, cov, tot, e2e, derived } = counts(run);
  return [
    stat("Correct escalations", judged.filter((c) => c.firstAction === "match").length, judged.length),
    stat(`Solved end to end${derived ? " (derived)" : ""}`, e2e, judged.length),
    stat("Broker actions covered", cov, tot),
    stat("No red flags", judged.filter((c) => !c.violations).length, judged.length),
    stat("Closed", fin.filter((c) => c.closed).length, fin.length),
    fin.length < cs.length ? `<span>Finished<b>${fin.length}</b><span class="n">/${cs.length}</span></span>` : "",
  ].join("");
}

// ---------------- simple ----------------

async function renderSimple(runs, run, key, tab) {
  const keep = document.querySelector(".claims")?.scrollTop;
  app.innerHTML = `${header(runs, run, "simple", key)}
    <div class="score">${scoreSimple(run)}</div>
    <div class="body">
      <nav class="claims" aria-label="Claims">${claimRows(run, key, tab)}</nav>
      <section class="pane" id="pane"></section>
    </div>`;
  if (keep) document.querySelector(".claims").scrollTop = keep;
  bindRunSelect("simple");
  const pane = document.getElementById("pane");
  const sum = run.cases[key];
  pane.dataset.status = sum?.status ?? "";
  if (!sum || sum.status === "pending" || sum.status === "running") {
    pane.innerHTML = `<div class="empty"><b>Case ${esc(caseNo(key))} · ${esc(titles[key])}</b><span>${sum?.status === "running" ? "The agent is working on this claim." : "Waiting in the queue."}</span></div>`;
    return;
  }
  const { result: r, case: c } = await load(run.id, key);
  const j = r.judge?.output;
  const handler = r.handler?.length ? r.handler : [c.details.Broker].filter(Boolean);
  const realSent = c.events.filter((e) => e.n > r.takeover && handler.includes(e.from) && !isNote(e.channel)).length;
  const agentSent = r.replay.filter((m) => m.author === "agent" && m.kind === "message").length;
  const covered = j ? j.acts.filter((a) => a.covered).length : 0;
  const rows = [
    j && { label: "Escalation", tone: j.first_action.verdict, agent: esc(j.first_action.reason), real: esc(c.answer["Next action at escalation"] ?? "—"), diff: j.first_action.verdict !== "match" && "escalation" },
    j && { label: "End to end", tone: e2eVerdict(j).ok ? "match" : "miss", agent: `${e2eVerdict(j).ok ? "Correct" : "Not correct"}<div class="muted">${esc(e2eVerdict(j).reason)}</div>`, real: "—", diff: !e2eVerdict(j).ok && "end to end" },
    j && { label: "Broker actions", tone: covered === j.acts.length ? "match" : covered ? "partial" : "miss", agent: `${covered} of ${j.acts.length}${j.acts.some((a) => !a.covered) ? `<div class="muted">Missed: ${esc(j.acts.filter((a) => !a.covered).map((a) => a.act).join("; "))}</div>` : ""}`, real: String(j.acts.length), diff: covered < j.acts.length && "actions" },
    { label: "Emails sent", tone: agentSent === realSent ? "match" : "partial", agent: String(agentSent), real: String(realSent), diff: agentSent !== realSent && "emails sent" },
    j && { label: "Red flags", tone: j.violations.length ? "miss" : "match", agent: j.violations.length ? j.violations.map((v) => `<div><span class="quote">“${esc(v.quote)}”</span> <span class="muted">${esc(v.explanation)}</span></div>`).join("") : "None", real: "—", diff: j.violations.length > 0 && "red flags" },
    { label: "Outcome", tone: "", agent: r.agent.closed ? esc(r.agent.closed.outcome) : `<span class="muted">Left open</span>`, real: esc(c.answer.Outcome ?? "—") },
  ].filter(Boolean);
  const diffs = rows.map((x) => x.diff).filter(Boolean);
  const headline = r.status === "error" ? `<span class="headline bad">the run failed: ${esc(r.error)}</span>`
    : diffs.length ? `<span class="headline ${rows.some((x) => x.diff && x.tone === "miss") ? "bad" : "meh"}">${esc(diffs.join(", "))} differ</span>`
    : `<span class="headline ok">everything matches</span>`;
  pane.classList.add("splitpane");
  pane.innerHTML = `
    <div class="panetop">
      <div class="claimhead"><h1>Case ${esc(caseNo(key))} · ${esc(c.title)}</h1><a href="#/full/${run.id}/${key}">Technical details</a></div>
      ${startLine(run, r, c)}
      <details class="vs"><summary>Agent vs the real claim ${headline}</summary>
        <table class="cmp"><thead><tr><th></th><th>Agent</th><th>The real claim</th></tr></thead>
        <tbody>${rows.map((x) => `<tr><td><span class="dot ${x.tone}"></span>${x.label}</td><td>${x.agent}</td><td>${x.real}</td></tr>`).join("")}</tbody></table>
      </details>
    </div>
    <div class="split">
      <section class="col" id="chatcol" aria-label="Agent chat">${chat(run, r)}</section>
      <section class="col" id="mailcol" aria-label="Emails"></section>
    </div>`;
  const chatcol = document.getElementById("chatcol"), mailcol = document.getElementById("mailcol");
  bindChat(chatcol);
  const link = linkPanes(chatcol, mailcol, r, () => redraw());
  const redraw = drawMailbox(mailcol, r, c, handler, link.remark);
}

// Chat events and mailbox items about the same message light up together, and a click on one scrolls to the other.
// Chat side: data-ns lists the run's message numbers an event delivered, sent or read. Mailbox side: data-n (this run)
// or data-e (the real claim); the two are joined through each replay message's `follows`.
function linkPanes(chatcol, mailcol, r, redraw) {
  let current = null; // message numbers of the last selection, re-marked when the mailbox redraws
  const nums = (el) => el.dataset.ns.split(",").map(Number);
  const mark = (root, els, cls) => { root.querySelectorAll("." + cls).forEach((x) => x.classList.remove(cls)); els.forEach((x) => x.classList.add(cls)); };
  const mailSel = (ns) => (mailbox.side === "run" ? ns.map((n) => `.mail[data-n="${n}"]`) : [...new Set(ns.flatMap((n) => r.replay[n - 1]?.follows ?? []))].map((e) => `.mail[data-e="${e}"]`));
  const mailsFor = (ns) => { const sel = mailSel(ns); return sel.length ? [...mailcol.querySelectorAll(sel.join(","))] : []; };
  const nsOfMail = (m) => (m.dataset.n ? [Number(m.dataset.n)] : r.replay.filter((x) => x.follows.includes(Number(m.dataset.e))).map((x) => x.n));
  const chatFor = (ns) => [...chatcol.querySelectorAll("[data-ns]")].filter((el) => nums(el).some((n) => ns.includes(n)));
  const into = (el) => el?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  const hover = (from, sel, root, pick) => {
    let cur = null;
    from.addEventListener("mouseover", (e) => { const el = e.target.closest(sel); if (el !== cur) { cur = el; mark(root, el ? pick(el) : [], "lkh"); } });
    from.addEventListener("mouseleave", () => { cur = null; mark(root, [], "lkh"); });
  };

  chatcol.addEventListener("click", (e) => {
    const el = e.target.closest("[data-ns]");
    if (!el || e.target.closest("a")) return;
    current = nums(el);
    if (mailbox.filter !== "all" && mailsFor(current).length < mailSel(current).length) { mailbox.filter = "all"; redraw(); } // the linked email was filtered out
    const hits = mailsFor(current);
    mark(chatcol, [el], "lk");
    mark(mailcol, hits, "lk");
    into(hits[0]);
  });
  mailcol.addEventListener("click", (e) => {
    const m = e.target.closest(".mail");
    if (!m || e.target.closest("a")) return;
    current = nsOfMail(m);
    const hits = chatFor(current);
    mark(mailcol, [m], "lk");
    mark(chatcol, hits, "lk");
    into(hits.find((x) => x.dataset.origin) ?? hits[0]); // the event that sent or delivered it, before any later read of it
  });
  hover(chatcol, "[data-ns]", mailcol, (el) => mailsFor(nums(el)));
  hover(mailcol, ".mail", chatcol, (m) => chatFor(nsOfMail(m)));
  return { remark: () => { if (current) mark(mailcol, mailsFor(current), "lk"); } };
}

// Where the agent took over: the case's escalation point (the moment its "Next action at escalation" refers to),
// a fixed seed, or the opening. Runs made before escalation starts carry no `start` and began at the opening.
const startKind = (r) => (r.start === "escalation" ? "the escalation point" : r.start === "seed" ? "a fixed seed" : "the opening");
const sawEvents = (r, c) => (r.takeover ? `real event${r.takeover > 1 ? "s 1–" + r.takeover : " 1"} of ${c.events.length}` : "no real events");
function startLine(run, r, c) {
  const trigger = r.start === "escalation" && run.kit.escalation?.[r.key]?.trigger;
  return `<div class="startline ${r.start === "escalation" ? "esc" : ""}"><b>Starts at ${startKind(r)}</b> · the agent saw ${sawEvents(r, c)} and nothing after · case card ${cardLabel(run.kit.settings)}${trigger ? ` · ${esc(trigger)}` : ""}</div>`;
}

function claimRows(run, current, tab) {
  return `<div class="top">${Object.keys(run.cases).length} claims<span class="legend">escalation · end to end</span></div>` + Object.entries(run.cases).map(([key, s]) => {
    const dot = s.status === "pending" || s.status === "running" ? "wait" : s.status === "error" ? "error" : s.firstAction ?? "";
    const e = e2eOf(s);
    return `<a class="claim ${key === current ? "on" : ""}" href="#/simple/${run.id}/${key}/${tab}"><span class="no">${esc(caseNo(key))}</span><span class="tt">${esc(titles[key] ?? key)}</span><span class="dots"><span class="dot ${dot}" title="${esc(s.firstAction ? "escalation: " + s.firstAction : s.status)}"></span><span class="dot ${e === undefined ? "" : e ? "match" : "miss"}" title="end to end: ${e === undefined ? "not judged" : e ? "correct" : "not correct"}"></span></span></a>`;
  }).join("");
}

async function load(runId, key) {
  const id = `${runId}/${key}`;
  if (!results.has(id)) results.set(id, await api(`/api/runs/${runId}/cases/${key}`));
  return results.get(id);
}

// The mailbox: this run (agent + simulated parties) or the real claim, like Sophie Lab's email timeline.
function drawMailbox(box, r, c, handler, onDraw) {
  const first = (s) => s.split(/(?<=[.!?])\s+|\n/)[0].slice(0, 110);
  const item = (kind, { from, to, subject, body, attachments, time }, ref) => {
    const title = subject || first(body);
    const rest = subject ? body : body.slice(first(body).length).trim();
    return { kind, html: `<article class="mail ${kind}" tabindex="0" ${ref.n ? `data-n="${ref.n}"` : `data-e="${ref.e}"`}>
      <div class="ic">${ICON[kind]}</div>
      <div>
        <span class="mid">${ref.n ? "#" + pad3(ref.n) : "event " + ref.e}</span>
        <div class="t1"><b>${kind === "sent" ? "Sent" : kind === "note" ? "Note" : "Inbox"}</b>${esc(title)}</div>
        <div class="ft">From: <span>${esc(from)}</span></div>
        <div class="ft">To: <span>${esc(to)}</span></div>
        ${rest ? `<div class="pv">${esc(rest)}</div>` : ""}
        ${time || attachments.length ? `<div class="when">${time ? `<span>${esc(time)}</span>` : ""}${attachments.map((a) => `<a class="att" href="/api/cases/${c.key}/files/${encodeURIComponent(a)}" target="_blank" rel="noopener">${ICON.clip}${esc(a)}</a>`).join("")}</div>` : ""}
      </div></article>` };
  };
  const runItems = r.replay.map((m) => ({ after: m.turn > 0, ...item(m.kind === "note" ? "note" : m.author === "agent" || m.author === "handler" ? "sent" : "inbox", {
    from: m.author === "agent" ? `Agent (as ${handler[0] ?? "the broker"})` : m.from, to: m.to, subject: m.subject, body: m.body, attachments: m.attachments,
    time: m.ts ? day(m.ts) : m.author === "world" && m.match !== "verbatim" ? "Simulated reply" : "",
  }, { n: m.n }) }));
  const realItems = c.events.map((e) => ({ after: e.n > r.takeover, ...item(isNote(e.channel) ? "note" : handler.includes(e.from) ? "sent" : "inbox", {
    from: e.from, to: e.to, body: e.body, attachments: c.attachments.filter((a) => a.firstEvent === e.n).map((a) => a.name), time: day(e.ts),
  }, { e: e.n }) }));
  const expected = c.answer["Next action at escalation"];
  const cut = (side) => `<div class="cutline" role="separator"><b>${r.start === "escalation" ? "Escalation point" : "Agent takes over"}</b>
      <span>The agent saw ${sawEvents(r, c)}, shown above. ${side === "run" ? "Below is what it did and how the simulated parties answered." : "The real events below were hidden from it."}</span>
      ${expected ? `<span class="exp"><i>Expected next action</i>${esc(expected)}</span>` : ""}</div>`;
  const draw = () => {
    const items = (mailbox.side === "run" ? runItems : realItems).filter((x) => mailbox.filter === "all" || (mailbox.filter === "received" ? x.kind === "inbox" : x.kind !== "inbox"));
    const at = items.findIndex((x) => x.after);
    items.splice(at < 0 ? items.length : at, 0, { html: cut(mailbox.side) });
    box.innerHTML = `<div class="colhead"><h2>Emails</h2>
        <div class="pills">${[["all", "All"], ["received", "Received"], ["sent", "Sent"]].map(([v, l]) => `<button data-f="${v}" class="${mailbox.filter === v ? "on" : ""}">${l}</button>`).join("")}</div>
        <div class="pills">${[["run", "This run"], ["real", "The real claim"]].map(([v, l]) => `<button data-s="${v}" class="${mailbox.side === v ? "on" : ""}">${l}</button>`).join("")}</div>
      </div>
      <div class="mails">${items.map((x) => x.html).join("") || `<p class="muted">Nothing here.</p>`}</div>`;
    box.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { mailbox.filter = b.dataset.f; draw(); }));
    box.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => { mailbox.side = b.dataset.s; draw(); }));
    box.querySelectorAll(".mail").forEach((m) => (m.onclick = (e) => { if (!e.target.closest("a")) m.classList.add("open"); }));
    onDraw?.();
  };
  draw();
  return draw;
}

// The agent's transcript, like Sophie Lab's chat: a turn header per trigger, the agent's words as markdown,
// and every tool call as one line that expands. Thinking lives in Full.
const pad3 = (n) => String(n).padStart(3, "0");
const linkAttr = (ns, origin) => (ns.length ? ` data-ns="${ns.join(",")}"${origin ? ' data-origin="1"' : ""}` : "");
const refChips = (ns) => ns.slice(0, 4).map((n) => `<span class="ref">#${pad3(n)}</span>`).join("") + (ns.length > 4 ? `<span class="ref">+${ns.length - 4}</span>` : "");

// The council's sitting before an agent turn (absent in runs without advisers), and that turn's input without the
// proposals that were appended to it.
const adviceOf = (r, turn) => (r.advice ?? []).find((a) => a.turn === turn);
const ownInput = (r, turn, content) => { const a = adviceOf(r, turn); return a && content.endsWith(a.text) ? content.slice(0, -a.text.length) : content; };
const toolCount = (p) => Object.entries(p.steps.reduce((t, s) => ({ ...t, [s.name]: (t[s.name] ?? 0) + 1 }), {})).map(([n, k]) => `${n} ×${k}`).join(", ");

function council(a) {
  const ok = a.proposals.filter((p) => p.status === "ok").length;
  const rows = a.proposals.map((p) => `<details class="step read"><summary><span class="si">${ICON.search}</span><span class="sl"><b>${esc(p.title)}</b>${p.status === "ok" ? "" : '<span class="fail">no proposal</span>'}</span><span class="sx">${esc(p.status === "ok" ? firstLine(p.proposal.replace(/^PROPOSAL\s*/, "")) : p.note)}</span><span class="chev">›</span></summary><div class="sb"><div class="md">${md(p.status === "ok" ? p.proposal : p.note)}</div><div class="meta">${esc(p.preset)}${p.steps.length ? ` · ${esc(toolCount(p))}` : ""} · ${money(p.cost)} · ${dur(p.ms)}</div></div></details>`).join("");
  return `<details class="step turnhead"><summary><span class="si">${ICON.folder}</span><span class="sl">Advisers · ${ok} of ${a.proposals.length} proposals</span><span class="rule"></span><span class="chev">›</span></summary><div class="sb">${rows}</div></details>`;
}

function chat(run, r) {
  const silence = run.kit.prompts["agent.silence.md"];
  const results = new Map();
  for (const m of r.agent.messages) if (m.role === "user" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  const out = [];
  let turn = 0;
  for (const m of r.agent.messages) {
    if (m.role === "user" && typeof m.content === "string") {
      turn++;
      const own = ownInput(r, turn, m.content), adv = adviceOf(r, turn);
      const label = turn === 1 ? (r.start === "escalation" ? "Picked up at the escalation point" : "New case") : own === silence ? "No replies" : "New messages";
      const ns = [...own.matchAll(/^\/messages\/(\d+)$/gm)].map((x) => Number(x[1])); // the messages this turn handed to the agent
      out.push(`<details class="step turnhead"${linkAttr(ns, true)}><summary><span class="si">${ICON.bolt}</span><span class="sl">${label}${refChips(ns)}</span><span class="rule"></span><span class="chev">›</span></summary><div class="sb"><div class="md">${md(own.replace(/\n---\n/g, "\n\n---\n\n"))}</div></div></details>`); // header/body separators are rules, not setext headings
      if (adv) out.push(council(adv));
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "text" && b.text.trim()) out.push(`<div class="row"><span class="ai">AI</span><div class="md">${md(b.text)}</div></div>`);
        else if (b.type === "tool_use") out.push(step(b, results.get(b.id), r));
      }
    }
  }
  return `<div class="colhead"><h2>Agent chat</h2><span class="hint">Click an event or an email to find its counterpart</span><button class="linkbtn" id="toggleAll">Expand all</button></div><div class="chat">${out.join("")}</div>`;
}

function step(b, res, r) {
  const x = b.input || {};
  const result = typeof res?.content === "string" ? res.content : JSON.stringify(res?.content ?? "");
  const failed = Boolean(res?.is_error);
  // what this call is about: the message it saved, the message it read, or the email that carried the document it read
  const saved = /\/messages\/(\d+)/.exec(result), path = String(x.path ?? "");
  const origin = !failed && (b.name === "send_message" || b.name === "add_note") && saved;
  const ns = origin ? [Number(saved[1])]
    : b.name !== "read_case" || failed ? []
    : /^\/messages\/\d+$/.test(path) ? [Number(path.slice(10))]
    : r.replay.filter((m) => m.attachments.includes(path.replace(/^\/documents\//, ""))).slice(0, 1).map((m) => m.n);
  const row = (kind, icon, label, preview, body) => `<details class="step ${kind}"${linkAttr(ns, origin)}><summary><span class="si">${icon}</span><span class="sl">${label}${refChips(ns)}${failed ? '<span class="fail">failed</span>' : ""}</span><span class="sx">${esc(preview)}</span><span class="chev">›</span></summary><div class="sb">${failed ? `<pre class="plain bad">${esc(result)}</pre>` : body}</div></details>`;
  const attached = (x.attachments ?? []).length ? `<div class="meta">Attached: ${x.attachments.map(esc).join(", ")}</div>` : "";
  if (b.name === "send_message") return row("email", ICON.sent, `<b>Sent ${esc((x.channel || "email").toLowerCase())}</b> to ${esc(x.to)}`, x.subject || firstLine(x.body),
    `<div class="meta">To <b>${esc(x.to)}</b>${x.subject ? ` · ${esc(x.subject)}` : ""}</div><div class="md">${md(x.body)}</div>${attached}`);
  if (b.name === "add_note") return row("note", ICON.note, "<b>Added a note</b>", firstLine(x.body), `<div class="md">${md(x.body)}</div>`);
  if (b.name === "close_case") return row("close", ICON.done, "<b>Closed the case</b>", firstLine(x.outcome), `<div class="md">${md(x.outcome)}</div>`);
  if (b.name === "read_case") return row("read", ICON.file, `Read <code>${esc(x.path)}</code>`, "", /^\/messages\//.test(x.path) ? `<pre class="plain">${esc(result)}</pre>` : `<div class="md">${md(result)}</div>`);
  if (b.name === "list_case") return row("read", ICON.folder, `Listed <code>${esc(x.path || "/")}</code>`, "", `<pre>${esc(result)}</pre>`);
  if (b.name === "search_case") return row("read", ICON.search, `Searched for <code>${esc(x.pattern)}</code>`, "", `<pre>${esc(result)}</pre>`);
  return row("read", ICON.file, esc(b.name), "", `<pre>${esc(JSON.stringify(x, null, 2))}</pre><pre>${esc(result)}</pre>`);
}

function bindChat(box) {
  const btn = box.querySelector("#toggleAll");
  if (!btn) return;
  btn.onclick = () => {
    const all = [...box.querySelectorAll("details.step")];
    const open = !all.every((d) => d.open);
    all.forEach((d) => (d.open = open));
    btn.textContent = open ? "Collapse all" : "Expand all";
  };
}

// ---------------- full ----------------

function scoreFull(run) {
  const { cs, judged, fin, cov, tot, e2e, derived } = counts(run);
  return [
    `<span>Finished<b>${fin.length}</b><span class="n">/${cs.length}</span></span>`,
    stat("Escalations", judged.filter((c) => c.firstAction === "match").length, judged.length),
    stat(`End to end${derived ? " (derived)" : ""}`, e2e, judged.length),
    stat("Acts covered", cov, tot),
    `<span>Violations<b class="${judged.some((c) => c.violations) ? "bad" : "ok"}">${judged.reduce((t, c) => t + (c.violations || 0), 0)}</b></span>`,
    cs.some((c) => c.status === "error") ? `<span>Errors<b class="bad">${cs.filter((c) => c.status === "error").length}</b></span>` : "",
    `<span>Cost<b>${money(cs.reduce((t, c) => t + (c.cost || 0), 0))}</b></span>`,
  ].join("");
}

function subnav(active, run) {
  const s = run?.kit.settings;
  return `<nav class="subnav">
    <a href="#/full/${run ? run.id : ""}" class="${active === "cases" ? "on" : ""}">Cases</a>
    <a href="#/full/new" class="${active === "new" ? "on" : ""}">New run</a>
    <a href="#/full/settings" class="${active === "settings" ? "on" : ""}">Prompts &amp; settings</a>
    ${s ? `<span class="meta">case card <b>${cardLabel(s)}</b> · start <b>${s.seedEvents > 0 ? "seed " + s.seedEvents : s.startAt === "escalation" ? "escalation point" : "opening"}</b> · agent <b>${esc(s.agent)}</b> · simulator <b>${esc(s.simulator)}</b> · judge <b>${s.runJudge ? esc(s.judge) : "off"}</b> · <a href="#" id="cfg">Run config</a></span>` : ""}
  </nav>`;
}

function keyRows(run, current, tab) {
  return Object.entries(run.cases).map(([key, s]) => {
    const right = s.status === "pending" ? "queued" : s.status === "running" ? "running…" : s.status === "error" ? '<span class="bad">error</span>'
      : `<span class="${s.firstAction === "match" ? "ok" : s.firstAction === "partial" ? "meh" : "bad"}">${s.firstAction ?? "–"}</span>${e2eOf(s) === undefined ? "" : ` <span class="${e2eOf(s) ? "ok" : "bad"}">e2e</span>`} ${s.acts ? s.acts.join("/") : ""}${s.violations ? ` <span class="bad">!${s.violations}</span>` : ""} <span class="muted">${money(s.cost)}</span>`;
    return `<a href="#/full/${run.id}/${key}/${tab}" class="${key === current ? "on" : ""}" title="${esc(titles[key] ?? "")}"><span>${esc(caseNo(key))}</span><span>${right}</span></a>`;
  }).join("");
}

async function renderFull(runs, run, key, tab) {
  const keep = document.querySelector(".keys")?.scrollTop;
  app.innerHTML = `${header(runs, run, "full", key)}
    <div class="score">${scoreFull(run)}</div>
    <div class="full">${subnav("cases", run)}
      <div class="fullbody"><nav class="keys">${keyRows(run, key, tab)}</nav><section class="fullpane" id="pane"></section></div>
    </div>`;
  if (keep) document.querySelector(".keys").scrollTop = keep;
  bindRunSelect("full");
  document.getElementById("cfg").onclick = (e) => { e.preventDefault(); showConfig(run); };
  const pane = document.getElementById("pane");
  const sum = run.cases[key];
  pane.dataset.status = sum?.status ?? "";
  if (!sum || sum.status === "pending" || sum.status === "running") { pane.innerHTML = `<p class="muted">${esc(key)} is ${esc(sum?.status ?? "missing")}.</p>`; return; }
  const { result: r, case: c } = await load(run.id, key);
  const turns = Math.max(0, ...r.agent.calls.map((x) => x.turn));
  const tabs = [["trace", "Agent trace"], ["simulator", "Simulator"], ["judge", "Judge"], ["compare", "Side by side"]];
  pane.innerHTML = `
    <div class="round">${esc(key)} · ended: ${esc(r.stop)} · handler: ${esc((r.handler ?? []).join(", ") || "?")} · took over after event ${r.takeover}/${c.events.length} (${startKind(r)}) · ${turns} agent turns · ${money(r.cost)} · ${dur(r.ms)}${r.error ? ` · <span class="bad">${esc(r.error)}</span>` : ""}</div>
    <nav class="tabs">${tabs.map(([t, l]) => `<a href="#/full/${run.id}/${key}/${t}" class="${t === tab ? "on" : ""}">${l}</a>`).join("")}</nav>
    <div>${tab === "simulator" ? simTab(r) : tab === "judge" ? judgeTab(r, c) : tab === "compare" ? compareTab(r, c) : traceTab(run, r)}</div>`;
  pane.querySelectorAll(".raw pre").forEach((p) => (p.onclick = () => p.classList.add("open")));
}

const usage = (u) => `${kfmt(u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0))} in (${kfmt(u.cache_read_input_tokens || 0)} cached) / ${kfmt(u.output_tokens)} out`;
const fields = (o) => Object.entries(o || {}).map(([key, v]) => `<div><span class="lbl">${esc(key)}</span><pre>${esc(typeof v === "string" ? v : JSON.stringify(v, null, 2))}</pre></div>`).join("");

function traceTab(run, r) {
  const res = new Map();
  for (const m of r.agent.messages) if (m.role === "user" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") res.set(b.tool_use_id, b);
  const silence = run.kit.prompts["agent.silence.md"];
  const out = [`<details class="box"><summary><b>System prompt</b><span class="x">prompts/agent.system.md</span></summary><div class="io"><pre>${esc(r.agent.system)}</pre></div></details>`];
  let turn = 0, idx = 0;
  for (const m of r.agent.messages) {
    if (m.role === "user" && typeof m.content === "string") {
      turn++;
      out.push(`<div class="turn"><span class="lbl">Turn ${turn}</span><span class="muted">${turn === 1 ? "kickoff" : ownInput(r, turn, m.content) === silence ? "nobody replied" : "new messages"}</span></div><details class="box"><summary><span class="x">${esc(m.content.split("\n").find((l) => l.trim()))}</span></summary><div class="io"><pre>${esc(m.content)}</pre></div></details>`);
      const adv = adviceOf(r, turn);
      if (adv) out.push(`<div class="round">advisers before this turn · ${adv.proposals.filter((p) => p.status === "ok").length}/${adv.proposals.length} proposals · ${money(adv.proposals.reduce((t, p) => t + p.cost, 0))} · their proposals are appended to the input above</div>`,
        ...adv.proposals.map((p) => `<details class="box"><summary><b>${esc(p.title)}</b><span class="x">${esc(p.name)} · ${esc(p.preset)} · ${p.calls.length} calls${p.steps.length ? ` · ${esc(toolCount(p))}` : ""} · ${money(p.cost)} · ${dur(p.ms)}</span>${p.status === "ok" ? "" : `<span class="chip bad">no proposal</span>`}</summary><div class="io"><pre>${esc(p.status === "ok" ? p.proposal : p.note)}</pre></div>${p.steps.length ? `<div class="io"><span class="lbl">Tool calls</span><pre>${esc(p.steps.map((s) => `${s.name} ${JSON.stringify(s.input)}${s.result ? `\n  → ${s.result.replace(/\s+/g, " ").slice(0, 160)}` : ""}`).join("\n"))}</pre></div>` : ""}</details>`));
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "thinking" && b.thinking) out.push(`<div class="thinking">${esc(b.thinking)}</div>`);
        else if (b.type === "text" && b.text.trim()) out.push(`<div class="say">${esc(b.text)}</div>`);
        else if (b.type === "tool_use") {
          const x = res.get(b.id), i = b.input || {};
          const brief = i.path ?? i.pattern ?? (i.to ? `to ${i.to}: ${i.body ?? ""}` : (i.body ?? i.outcome ?? ""));
          const content = typeof x?.content === "string" ? x.content : JSON.stringify(x?.content ?? "(no result)");
          out.push(`<details class="box"><summary><b class="mono">${esc(b.name)}</b><span class="x">${esc(String(brief).replace(/\s+/g, " ").slice(0, 300))}</span>${x?.is_error ? `<span class="chip bad">error</span>` : ""}</summary><div class="io">${fields(i) || '<span class="muted">no input</span>'}</div><div class="io"><span class="lbl">Result</span><pre class="${x?.is_error ? "err" : ""}">${esc(content)}</pre></div></details>`);
        }
      }
      const meta = r.agent.calls[idx++];
      if (meta) out.push(`<div class="round">round ${meta.round} · ${esc(meta.preset)} · ${meta.stop_reason} · ${usage(meta.usage)} · ${money(meta.cost)} · ${dur(meta.ms)}</div>`);
    }
  }
  if (r.extract.length) out.push(`<div class="round">attachment extraction: ${r.extract.length} calls · ${money(r.extract.reduce((t, x) => t + x.cost, 0))}</div>`);
  return `<div class="trace">${out.join("")}</div>`;
}

function simTab(r) {
  if (!r.world.length) return `<p class="muted">The simulator did not run.</p>`;
  return `<div class="trace">${r.world.map((w) => {
    const o = w.output;
    return `<div class="turn"><span class="lbl">${w.turn === 0 ? "Opening" : `After agent turn ${w.turn}`}</span><span class="muted">answering ${w.pending.map((n) => "#" + n).join(", ") || "nothing new"} · delivered ${w.delivered.map((n) => "#" + n).join(", ") || "nothing"} · ${usage(w.call.usage)} · ${money(w.call.cost)} · ${dur(w.call.ms)}</span></div>
      <div class="say">${esc(o.reasoning)}</div>
      ${o.agent_message_matches?.length ? `<div class="muted">agent ↔ real: ${o.agent_message_matches.map((x) => `#${x.message} → ${x.real_events.join(", ") || "none"}`).join(" · ")}</div>` : ""}
      ${o.messages.length ? `<div>${o.messages.map((x) => `<div><span class="chip ${x.match}">${esc(x.match.replace(/_/g, " "))}</span> ${esc(x.from)} → ${esc(x.to)} <span class="muted">events ${x.follows_events.join(", ") || "none"}</span></div>`).join("")}</div>` : ""}
      <details class="box"><summary>Prompt sent to the simulator</summary><div class="io"><pre>${esc(w.prompt)}</pre></div></details>`;
  }).join("")}</div>`;
}

function judgeTab(r, c) {
  const key = Object.entries(c.answer).map(([h, b]) => `<div><span class="lbl">${esc(h)}</span><div class="say">${esc(b)}</div></div>`).join("");
  if (!r.judge) return `<p class="muted">Not judged in this run.</p>${key}`;
  const j = r.judge.output;
  return `<div class="trace">
    <div><span class="lbl">Escalation (first action)</span> <span class="chip ${j.first_action.verdict}">${j.first_action.verdict}</span><div class="say">${esc(j.first_action.reason)}</div></div>
    <div><span class="lbl">End to end</span> <span class="chip ${e2eVerdict(j).ok ? "match" : "miss"}">${e2eVerdict(j).ok ? "correct" : "incorrect"}</span><div class="say">${esc(e2eVerdict(j).reason)}</div></div>
    <div><span class="lbl">Summary</span><div class="say">${esc(j.summary)}</div></div>
    <table class="t"><thead><tr><th>Real handler did</th><th>Party</th><th>Agent</th><th>Evidence</th></tr></thead><tbody>${j.acts.map((a) => `<tr><td>${esc(a.act)}</td><td>${esc(a.party)}</td><td>${a.covered ? '<span class="ok">done</span>' : '<span class="bad">missed</span>'}</td><td class="muted">${esc(a.evidence)}</td></tr>`).join("")}</tbody></table>
    ${j.extras.length ? `<table class="t"><thead><tr><th>Agent also did</th><th>Party</th><th></th><th>Note</th></tr></thead><tbody>${j.extras.map((x) => `<tr><td>${esc(x.act)}</td><td>${esc(x.party)}</td><td>${x.problem ? '<span class="bad">problem</span>' : '<span class="muted">fine</span>'}</td><td class="muted">${esc(x.note)}</td></tr>`).join("")}</tbody></table>` : ""}
    ${j.violations.length ? `<div><span class="lbl">Violations</span>${j.violations.map((v) => `<div>“${esc(v.quote)}” <span class="muted">${esc(v.explanation)}</span></div>`).join("")}</div>` : ""}
    <details class="box"><summary>Answer key</summary><div class="io">${key}</div></details>
    <details class="box"><summary>Prompt sent to the judge · ${money(r.judge.call.cost)}</summary><div class="io"><pre>${esc(r.judge.prompt)}</pre></div></details>
  </div>`;
}

// Replay against the real claim, real timeline as the spine (claimsorted's correspondence pairs).
function compareTab(r, c) {
  const after = r.replay.filter((m) => m.turn > 0);
  const byN = Object.fromEntries(c.events.map((e) => [e.n, e]));
  const pairOf = new Map(), taken = new Set();
  for (const m of after) { const g = m.follows.find((n) => n > r.takeover && !taken.has(n)); if (g) { pairOf.set(m.n, g); taken.add(g); } }
  const twin = new Map([...pairOf].map(([m, g]) => [g, m]));
  const rows = [], shown = new Set();
  let i = 0;
  const take = () => { const m = after[i++]; const g = pairOf.get(m.n); if (g) shown.add(g); rows.push({ m, e: g && byN[g] }); return m; };
  for (const e of c.events.filter((x) => x.n > r.takeover)) {
    if (shown.has(e.n)) continue;
    const mn = twin.get(e.n);
    if (mn === undefined) rows.push({ e }); else while (i < after.length && take().n !== mn);
  }
  while (i < after.length) take();
  const handler = r.handler ?? [];
  const ev = (e) => `<div class="raw ${handler.includes(e.from) ? "out" : "in"}"><div class="h"><b>${esc(e.from)}</b> → ${esc(e.to)} <span class="chip">${esc(e.channel)}</span><span class="r n">event ${e.n}</span></div><pre>${esc(e.body)}</pre></div>`;
  const msg = (m, paired) => `<div class="raw ${m.author === "world" ? "in" : m.kind === "note" ? "" : paired ? "out" : "bad"}"><div class="h"><b>${esc(m.from)}</b> → ${esc(m.to)} <span class="chip">${esc(m.channel)}</span>${m.match ? `<span class="chip ${m.match}">${esc(m.match.replace(/_/g, " "))}</span>` : ""}<span class="r n">#${m.n} · turn ${m.turn}${m.follows.length ? ` · ≈ ${m.follows.join(", ")}` : ""}</span></div><pre>${esc(m.body)}</pre>${m.stripped?.length ? `<div class="strip">removed by grounding: ${m.stripped.map(esc).join(" · ")}</div>` : ""}</div>`;
  const ctx = c.events.filter((e) => e.n <= r.takeover);
  return `<div class="grid2">
    <span class="lbl">Replay</span><span class="lbl">Real claim</span>
    ${ctx.length ? `<div class="divider">before takeover</div>${ctx.map((e) => `<div class="span">${ev(e)}</div>`).join("")}` : ""}
    <div class="divider">agent takes over${r.start === "escalation" ? " · escalation point" : ""}</div>
    ${rows.map(({ m, e }) => (m ? msg(m, Boolean(e)) : `<div class="hole2">nothing in the replay</div>`) + (e ? ev(e) : `<div class="hole2">not in the real claim</div>`)).join("")}
  </div>
  <p class="muted">${rows.filter((x) => x.m && x.e).length} matched · ${rows.filter((x) => x.m && !x.e).length} only in the replay · ${rows.filter((x) => x.e && !x.m).length} only in the real claim. Click a message to expand.</p>`;
}

function showConfig(run) {
  const kit = run.kit, s = kit.settings;
  const d = document.createElement("dialog");
  d.innerHTML = `<div class="dh"><b>Run config · ${esc(run.label)}</b><button class="btn">Close</button></div>
    <div class="db">
      <p class="muted">Snapshot taken when this run started. Edit the live files under Prompts &amp; settings.</p>
      <details class="box" open><summary>config/settings.json</summary><div class="io"><pre>${esc(JSON.stringify(s, null, 2))}</pre></div></details>
      ${(s.advisers ?? []).length ? `<details class="box"><summary>config/advisers.json</summary><div class="io"><pre>${esc(JSON.stringify(Object.fromEntries(s.advisers.map((n) => [n, kit.advisers?.[n]])), null, 2))}</pre></div></details>` : ""}
      ${[...new Set([s.agent, s.simulator, s.judge, s.extractor, ...(s.advisers ?? []).map((n) => kit.advisers?.[n]?.preset).filter(Boolean)])].map((p) => `<details class="box"><summary>model preset · ${esc(p)}</summary><div class="io"><pre>${esc(JSON.stringify(kit.models[p], null, 2))}</pre></div></details>`).join("")}
      ${Object.entries(kit.prompts).map(([n, t]) => `<details class="box"><summary>prompts/${esc(n)}</summary><div class="io"><pre>${esc(t)}</pre></div></details>`).join("")}
    </div>`;
  document.body.append(d);
  d.querySelector("button").onclick = () => d.close();
  d.addEventListener("close", () => d.remove());
  d.showModal();
}

function plainHeader(title) {
  return `<div class="head"><span class="crumb">Case Lab</span><span class="runsel" style="background:none;cursor:default">${title}</span>
    <nav class="toggle" aria-label="View"><a href="#/simple">Simple</a><a href="#/full" class="on">Full</a></nav></div>`;
}

const presetLine = (p) => (p ? [p.model, `max_tokens ${p.max_tokens}`, p.thinking ? `thinking ${p.thinking.type}` : "no thinking", p.output_config?.effort && `effort ${p.output_config.effort}`].filter(Boolean).join(" · ") : "");

async function renderNew() {
  const [{ cases, splits }, models, settings, advisers] = await Promise.all([
    api("/api/cases"),
    api("/api/files?path=config/models.json").then(JSON.parse),
    api("/api/files?path=config/settings.json").then(JSON.parse),
    api("/api/files?path=config/advisers.json").then(JSON.parse).catch(() => ({})),
  ]);
  const roles = ["agent", "simulator", "judge", "extractor"];
  app.innerHTML = `${plainHeader("New run")}<div class="full">${subnav("new")}
    <form class="form" id="f">
      <label>Label <input id="label" value="baseline" required></label>
      <fieldset><legend>Claims</legend>
        <div class="row">${[["holdout", `Holdout (${splits.holdout.length})`], ["dev", `Dev (${splits.dev.length})`], ["all", `All (${cases.length})`], ["pick", "Pick claims"]].map(([v, l], i) => `<label><input type="radio" name="split" value="${v}" ${i === 0 ? "checked" : ""}> ${l}</label>`).join("")}</div>
        <textarea id="keys" rows="2" placeholder="insurance-032, insurance-037" hidden></textarea>
        <div id="count" class="muted"></div>
      </fieldset>
      <fieldset><legend>Models · presets from config/models.json</legend>
        <div class="fields">${roles.map((r) => `<label>${r}<select id="p-${r}">${Object.keys(models).map((m) => `<option ${m === settings[r] ? "selected" : ""}>${esc(m)}</option>`).join("")}</select><span class="n" id="d-${r}"></span></label>`).join("")}</div>
      </fieldset>
      <fieldset><legend>Advisers · sub-agents that each propose next steps before the agent decides (config/advisers.json)</legend>
        <div class="row">${Object.entries(advisers).map(([n, a]) => `<label title="${esc(presetLine(models[a.preset]))} · tools: ${esc(a.tools.join(", "))} · ${a.when === "first" ? "only when the agent picks the case up" : "before every agent turn"}"><input type="checkbox" name="adviser" value="${esc(n)}" ${(settings.advisers ?? []).includes(n) ? "checked" : ""}> ${esc(a.title)}</label>`).join("") || '<span class="muted">none configured</span>'}</div>
      </fieldset>
      <fieldset><legend>Loop</legend>
        <div class="fields">
          <label>Agent is told from the case card (index.md)<select id="caseCard">${[["none", "Nothing: only who it is"], ["record", "Who it is, plus broker, insurer and property"], ["full", "The whole card: title, details, request"]].map(([v, l]) => `<option value="${v}" ${v === (settings.caseCard ?? "full") ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label>Agent starts<select id="startAt">${[["escalation", "At the escalation point (config/escalation.json)"], ["opening", "At the opening (the simulator opens the claim)"]].map(([v, l]) => `<option value="${v}" ${v === (settings.startAt ?? "opening") ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label>Seed events (0: start as chosen; N: hand over the first N real events instead)<input id="seedEvents" type="number" min="0" value="${settings.seedEvents}"></label>
          <label>Max world turns<input id="maxWorldTurns" type="number" min="0" value="${settings.maxWorldTurns}"></label>
          <label>Max tool rounds per agent turn<input id="maxToolRounds" type="number" min="1" value="${settings.maxToolRounds}"></label>
          <label>Claims in parallel<input id="concurrency" type="number" min="1" value="${settings.concurrency}"></label>
          <label><span><input id="runJudge" type="checkbox" ${settings.runJudge ? "checked" : ""}> Run the judge</span></label>
        </div>
      </fieldset>
      <div class="row"><button class="btn primary" type="submit">Start run</button><span id="err" class="bad"></span></div>
    </form></div>`;
  const f = document.getElementById("f");
  const $ = (id) => document.getElementById(id);
  const selected = () => (f.split.value === "pick" ? $("keys").value.split(/[\s,]+/).filter(Boolean) : f.split.value === "all" ? cases.map((c) => c.key) : splits[f.split.value]);
  const update = () => {
    $("keys").hidden = f.split.value !== "pick";
    const n = selected().length;
    $("count").textContent = `${n} ${n === 1 ? "claim" : "claims"} selected`;
    for (const r of roles) $(`d-${r}`).textContent = presetLine(models[$(`p-${r}`).value]);
  };
  f.addEventListener("input", update);
  update();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const num = (id) => Number($(id).value);
    try {
      const { id } = await api("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: $("label").value,
          keys: selected(),
          overrides: { ...Object.fromEntries(roles.map((r) => [r, $(`p-${r}`).value])), caseCard: $("caseCard").value, startAt: $("startAt").value, seedEvents: num("seedEvents"), maxWorldTurns: num("maxWorldTurns"), maxToolRounds: num("maxToolRounds"), concurrency: num("concurrency"), runJudge: $("runJudge").checked, advisers: [...f.querySelectorAll("input[name=adviser]:checked")].map((x) => x.value) },
        }),
      });
      location.hash = `#/simple/${id}`;
    } catch (err) {
      $("err").textContent = err.message;
    }
  };
}

const HINTS = {
  "settings.json": "Defaults for new runs: the model preset for each role, loop limits, judge on or off.",
  "models.json": "Model presets, sent to the Messages API as-is: model, max_tokens, thinking, effort, betas.",
  "pricing.json": "Dollars per million tokens [input, output], for cost figures.",
  "splits.json": "Dev and holdout claim lists.",
  "escalation.json": "Each claim's escalation point: the agent is handed real events 1..after and nothing later. From eval/public_escalation_points.json.",
  "advisers.json": "The council: sub-agents that each propose next steps before the agent's turn. Per adviser: title, model preset, prompt file, tool groups (case, web, claims) and when it sits (first: when the agent picks the case up; every: before each turn). settings.json → advisers picks who sits.",
  "adviser.system.md": "System prompt shared by every adviser. Variables: {{lens}} (the adviser's own prompt file)",
  "adviser.user.md": "What an adviser is shown. Variables: {{case_file}} {{messages}} {{documents}} {{latest}}",
  "adviser.claims.md": "Appended for advisers with the claims tools. Variables: {{catalogue}}",
  "adviser.tools.json": "Tool groups for advisers: case (names from tools.json), web (server-side web search and fetch), claims (the other claims in the database).",
  "adviser.creative.md": "Angle of the creative adviser.",
  "adviser.risk.md": "Angle of the conservative risk assessor.",
  "adviser.web.md": "Angle of the web researcher (UK guidance).",
  "adviser.wordings.md": "Angle of the policy-wording researcher (UK insurers' wordings).",
  "adviser.precedent.md": "Angle of the precedent analyst (other claims in the database).",
  "agent.advice.md": "Appended to the agent's input when advisers sat before the turn. Variables: {{proposals}}",
  "agent.system.md": "The agent's system prompt.",
  "agent.kickoff.md": "First message to the agent. Variables: {{case_file}} {{messages}} {{documents}}",
  "agent.update.md": "Sent when new messages arrive. Variables: {{messages}} {{documents}}",
  "agent.silence.md": "Sent once when nobody replies.",
  "tools.json": "The agent's tools. Keep the names; descriptions and schemas are yours to change.",
  "simulator.system.md": "System prompt for the simulated parties.",
  "simulator.user.md": "Variables: {{case_file}} {{real_events}} {{replay}} {{pending}}",
  "simulator.schema.json": "Structured output the simulator returns.",
  "judge.system.md": "System prompt for the judge.",
  "judge.user.md": "Variables: {{case_file}} {{answer_key}} {{context_events}} {{real_events}} {{replay}} {{documents}} {{agent_outcome}}",
  "judge.schema.json": "Structured output the judge returns.",
  "extract.system.md": "How PDF and image attachments become text (cached after the first read).",
  "extract.user.md": "Variables: {{filename}}",
};

async function renderSettings(file) {
  const files = await api("/api/files");
  file = files.includes(file) ? file : "prompts/agent.system.md";
  const text = await api(`/api/files?path=${encodeURIComponent(file)}`);
  const group = (dir) => files.filter((f) => f.startsWith(dir + "/")).map((f) => `<a href="#/full/settings/${f}" class="${f === file ? "on" : ""}">${esc(f.slice(dir.length + 1))}</a>`).join("");
  app.innerHTML = `${plainHeader("Prompts &amp; settings")}<div class="full">${subnav("settings")}
    <div class="settings">
      <nav class="files"><div class="lbl">Prompts</div>${group("prompts")}<div class="lbl">Config</div>${group("config")}</nav>
      <section class="editor">
        <div class="ebar"><b class="mono">${esc(file)}</b><span class="muted">${esc(HINTS[file.split("/")[1]] ?? "")}</span><span id="st" class="muted" style="margin-left:auto"></span><button class="btn primary" id="save">Save</button></div>
        <textarea id="ed" spellcheck="false" aria-label="${esc(file)}"></textarea>
        <div class="muted">Saved changes apply to the next run. Every run keeps a snapshot of what it used (Run config).</div>
      </section>
    </div></div>`;
  const ed = document.getElementById("ed"), st = document.getElementById("st");
  ed.value = text;
  ed.oninput = () => { st.textContent = "Unsaved changes"; st.className = "meh"; };
  const save = async () => {
    try {
      await api(`/api/files?path=${encodeURIComponent(file)}`, { method: "PUT", body: ed.value });
      st.textContent = "Saved";
      st.className = "ok";
    } catch (e) {
      st.textContent = e.message;
      st.className = "bad";
    }
  };
  document.getElementById("save").onclick = save;
  ed.onkeydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } };
}
