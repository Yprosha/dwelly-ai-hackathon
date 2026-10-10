// The outside world: every party except the handler, replayed from the real history,
// with code-side guards: real event ids only, real attachments only, no invented figures.
import type { Case, Event } from "./cases.ts";
import { caseFile, docText, eventAttachments, push, type Ctx, type Msg } from "./casefs.ts";
import { call, jsonOf, jsonPrompt, promptOf, render, type Call } from "./llm.ts";

export type Offense = { message: number; verdict: string; quotes: string[]; reason: string };
type SimOutput = {
  handler: string[];
  agent_message_matches: (Offense & { real_events: number[] })[];
  messages: { follows_events: number[]; match: string; from: string; to: string; channel: string; body: string; attachments: string[] }[];
  reasoning: string;
};
export type WorldTurn = { turn: number; pending: number[]; delivered: number[]; offenses: Offense[]; output: SimOutput; prompt: string; call: Call };

export function renderEvent(c: Case, e: Event): string {
  const att = eventAttachments(c, e);
  return [`--- event ${e.n} · ${e.ts} UTC · ${e.channel} ---`, `from: ${e.from}`, `to: ${e.to}`, e.subject && `subject: ${e.subject}`, att.length > 0 && `attachments: ${att.join(", ")}`, "", e.body].filter((x) => x !== false && x !== undefined).join("\n");
}

export function renderReplay(m: Msg): string {
  const who = m.author === "agent" ? "AGENT (handler)"
    : m.author === "handler" ? `REAL HANDLER, before the agent took over · real event ${m.follows[0]} verbatim`
    : m.match === "verbatim" ? `OTHER SIDE · real event ${m.follows[0]} verbatim` : "OTHER SIDE";
  return [`--- #${m.n} · ${who} · ${m.channel} ---`, `from: ${m.from}`, `to: ${m.to}`, m.subject && `subject: ${m.subject}`, m.attachments.length > 0 && `attachments: ${m.attachments.join(", ")}`, "", m.body]
    .filter((x) => x !== false && x !== undefined).join("\n");
}

// Drop sentences carrying a 2+ digit number that appears in none of the supporting texts (strict grounding).
export function ground(body: string, support: string[]): { body: string; stripped: string[] } {
  const known = new Set(support.flatMap((s) => s.match(/\d+/g) ?? []));
  const stripped: string[] = [];
  const lines = body.split("\n").map((line) =>
    line.split(/(?<=[.!?])\s+/).filter((sentence) => {
      const bad = (sentence.match(/\d+/g) ?? []).some((run) => run.length >= 2 && !known.has(run));
      if (bad) stripped.push(sentence.trim());
      return !bad;
    }).join(" "));
  return { body: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), stripped };
}

function verbatim(c: Case, e: Event): Omit<Msg, "n" | "turn"> {
  return { author: "world", kind: /note/i.test(e.channel) ? "note" : "message", channel: e.channel, from: e.from, to: e.to, subject: e.subject, body: e.body, ts: e.ts, attachments: eventAttachments(c, e), follows: [e.n], match: "verbatim" };
}

// Hand the agent the first N real events as they happened: the history up to its takeover point. The real handler's
// own messages and notes among them are marked as such; ctx.handler must be set first.
export function seed({ c, replay, handler }: Ctx, n: number) {
  for (const e of c.events.slice(0, n)) push(replay, { ...verbatim(c, e), author: handler.includes(e.from) ? "handler" : "world", turn: 0 });
}

// The real attachments as text, each with the real event that first carried it. The simulated parties answer
// questions about their own documents from this, and a figure found in a real document counts as grounded.
async function realDocs(ctx: Ctx): Promise<{ rendered: string; texts: string[] }> {
  const { c } = ctx;
  const rendered: string[] = [], texts: string[] = [];
  for (const a of c.attachments) {
    const text = await docText(ctx, a.name);
    const e = c.events.find((x) => x.n === a.firstEvent);
    texts.push(text);
    rendered.push(`### ${a.name} · ${e ? `first sent at event ${e.n}, from ${e.from} to ${e.to}` : "on the case file, mentioned in no event"}\n\n${text}`);
  }
  return { rendered: rendered.join("\n\n") || "(none)", texts };
}

export async function worldTurn(ctx: Ctx, pending: Msg[], turn: number): Promise<WorldTurn> {
  const { kit, c, replay } = ctx;
  const docs = await realDocs(ctx);
  const prompt = render(promptOf(kit, "simulator.user.md"), {
    case_file: caseFile(kit, c),
    real_events: c.events.map((e) => renderEvent(c, e)).join("\n\n"),
    documents: docs.rendered,
    replay: replay.map(renderReplay).join("\n\n") || "(empty: the case is just starting)",
    pending: pending.map(renderReplay).join("\n\n") || "(nothing)",
  });
  const r = await call(kit, "simulator", { system: promptOf(kit, "simulator.system.md"), messages: [{ role: "user", content: prompt }], schema: jsonPrompt(kit, "simulator.schema.json") });
  const out = jsonOf<SimOutput>(r.message);
  if (!ctx.handler.length) ctx.handler = out.handler.filter((h) => c.events.some((e) => e.from === h || e.to === h));
  const real = (ns: number[]) => ns.filter((n) => c.events.some((e) => e.n === n));

  const offenses: Offense[] = [];
  for (const m of out.agent_message_matches) {
    const msg = replay.find((x) => x.n === m.message && x.author === "agent");
    if (!msg) continue;
    msg.follows = real(m.real_events);
    if (msg.kind === "note") continue; // internal notes reach nobody
    Object.assign(msg, { verdict: m.verdict, reason: m.reason, quotes: m.quotes });
    if (kit.settings.failOn?.includes(m.verdict)) offenses.push({ message: m.message, verdict: m.verdict, quotes: m.quotes, reason: m.reason });
  }
  // asked for or sent something the real case does not support: the run fails here, nobody answers
  if (offenses.length) return { turn, pending: pending.map((m) => m.n), delivered: [], offenses, output: out, prompt, call: r.call };

  const delivered: number[] = [];
  for (const o of out.messages) {
    const follows = real(o.follows_events);
    const sent = new Set(replay.flatMap((m) => m.attachments));
    const event = (n: number) => c.events.find((e) => e.n === n)!;
    let msg: Omit<Msg, "n" | "turn">;
    if (o.match === "verbatim" && follows.length === 1) msg = verbatim(c, event(follows[0]));
    else {
      const support = [caseFile(kit, c), ...follows.map((n) => event(n).body), ...replay.map((m) => m.body), ...docs.texts];
      const g = ground(o.body, support);
      if (!g.body && follows.length > 0) msg = { ...verbatim(c, event(follows[0])), stripped: g.stripped }; // nothing left: fall back to the real message
      else if (!g.body) continue;
      else msg = {
        author: "world", kind: /note/i.test(o.channel) ? "note" : "message", channel: o.channel, from: o.from, to: o.to, body: g.body, follows, match: o.match, stripped: g.stripped,
        attachments: o.attachments.filter((a) => c.attachments.some((x) => x.name === a) && !sent.has(a)),
      };
    }
    delivered.push(push(replay, { ...msg, turn }).n);
  }
  return { turn, pending: pending.map((m) => m.n), delivered, offenses, output: out, prompt, call: r.call };
}
