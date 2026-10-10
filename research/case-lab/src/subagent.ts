// Sub-agents. The agent launches one with run_subagent and an instruction of its own choosing; the sub-agent sees the
// case as it stands, can read it, search the other claims in the database and the web, and reports back. It never acts.
import type Anthropic from "@anthropic-ai/sdk";
import { allCases, type Case } from "./cases.ts";
import { agentBrief, caseFile, fsTool, renderMsg, visibleDocs, type Ctx } from "./casefs.ts";
import { call, jsonPrompt, promptOf, render, type Call, type Kit } from "./llm.ts";

// What a sub-agent did, in order: what it said between tool calls, the tools it called and what came back. Enough for
// the UI to replay its work the way it shows the agent's own chat. The content of web pages is not kept.
export type ToolStep = { name: string; input: unknown; result?: string; error?: boolean; links?: { title: string; url: string }[] };
export type Step = { text: string } | ToolStep;

export type SubagentRun = {
  id: string; // the agent's run_subagent tool_use id
  turn: number;
  instruction: string;
  input: string; // what the sub-agent was shown
  report: string;
  error?: string; // why there is no report
  steps: Step[];
  calls: Call[];
  cost: number; ms: number;
};

const MAX_ROUNDS = 25; // model rounds per sub-agent; the last one has no tools, so it always ends in a report
const MAX_KEEP = 30_000; // characters of one tool result kept in the trace
const DEADLINE_MS = 900_000; // a sub-agent still working after this fails and the agent goes on without it
const CASE_TOOLS = ["list_case", "read_case", "search_case"];

// Never throws: a failed sub-agent comes back with `error` and whatever it cost.
export async function runSubagent(ctx: Ctx, id: string, turn: number, instruction: string): Promise<SubagentRun> {
  const { kit, c, replay } = ctx;
  const t0 = Date.now();
  const s: SubagentRun = { id, turn, instruction, input: "", report: "", steps: [], calls: [], cost: 0, ms: 0 };
  let late = false;
  const work = async () => {
    const tools = [...jsonPrompt<{ name: string }[]>(kit, "tools.json").filter((t) => CASE_TOOLS.includes(t.name)), ...jsonPrompt<unknown[]>(kit, "subagent.tools.json")];
    const others = otherClaims(c);
    const system = promptOf(kit, "subagent.system.md");
    const user = render(promptOf(kit, "subagent.user.md"), {
      case_file: agentBrief(kit, c),
      messages: replay.map(renderMsg).join("\n\n"),
      documents: visibleDocs(ctx).map((d) => `/documents/${d}`).join("\n") || "(none)",
      claims: others.map(gist).join("\n") || "(none)",
      instruction,
    });
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: user }];
    s.input = user;
    const pending = new Map<string, ToolStep>(); // server-side tool calls waiting for their result block
    for (let round = 1; round <= MAX_ROUNDS && !late; round++) {
      const { message, call: meta } = await call(kit, "subagent", { system, messages, tools, toolChoiceNone: round === MAX_ROUNDS });
      if (late) return; // timed out while this call was in flight: its result is dropped
      s.calls.push(meta);
      messages.push({ role: "assistant", content: message.content });
      const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const paused = message.stop_reason === "pause_turn";
      // the report is the text after the last tool block of the last message; any text before that is said along the way
      const last = message.content.findLastIndex((b) => b.type !== "text" && b.type !== "thinking" && b.type !== "redacted_thinking");
      message.content.forEach((b, i) => {
        const id = (b as { tool_use_id?: unknown }).tool_use_id;
        if (b.type === "text") { if (b.text.trim() && (uses.length || paused || i < last)) s.steps.push({ text: b.text.trim() }); }
        else if (b.type === "server_tool_use") { const t: ToolStep = { name: b.name, input: b.input }; s.steps.push(t); pending.set(b.id, t); }
        else if (typeof id === "string" && pending.has(id)) Object.assign(pending.get(id)!, serverResult((b as { content?: unknown }).content));
      });
      if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") throw new Error(`sub-agent stopped: ${message.stop_reason}`);
      if (paused) continue; // a long server-side tool loop paused: sent again as is, it resumes
      if (!uses.length) {
        s.report = message.content.slice(last + 1).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
        break;
      }
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        const input = u.input as any;
        let content: string, failed = false;
        try {
          content = u.name === "search_claims" ? searchClaims(others, String(input?.query ?? ""))
            : u.name === "read_claim" ? readClaim(kit, others, String(input?.claim_id ?? ""))
            : await fsTool(ctx, u.name, input);
        } catch (e) { content = e instanceof Error ? e.message : String(e); failed = true; }
        s.steps.push({ name: u.name, input, result: content.slice(0, MAX_KEEP), ...(failed ? { error: true } : {}) });
        results.push({ type: "tool_result", tool_use_id: u.id, content, ...(failed ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
    if (!s.report) throw new Error("no report produced");
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([work(), new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`no report within ${DEADLINE_MS / 1000}s`)), DEADLINE_MS); })]);
  } catch (e) {
    s.report = "";
    s.error = e instanceof Error ? e.message : String(e);
  }
  late = true; // a timed-out sub-agent stops when its call in flight returns
  clearTimeout(timer);
  s.cost = s.calls.reduce((a, x) => a + x.cost, 0);
  s.ms = Date.now() - t0;
  return s;
}

// What a server-side tool returned, reduced to what a reader needs: the pages a search found, the page a fetch opened,
// what the code printed.
function serverResult(c: any): Partial<ToolStep> {
  const link = (x: any) => ({ title: String(x.title ?? x.content?.title ?? x.url), url: String(x.url) });
  if (Array.isArray(c)) return { links: c.filter((x) => x?.url).map(link) };
  if (c?.error_code) return { result: String(c.error_code), error: true };
  if (c?.url) return { links: [link(c)] };
  const out = [c?.stdout, c?.stderr].filter((s) => typeof s === "string" && s.trim()).join("\n");
  return out ? { result: out.slice(0, 4000) } : {};
}

// The claims a sub-agent may read: every other claim, answers included, but never the one being worked on,
// which also means no other file on the same property (the synthetic sets continue one claim across cases).
export const otherClaims = (c: Case) => allCases().filter((o) => o.key !== c.key && (!c.details.Property || o.details.Property !== c.details.Property));

// ---- the other claims on the books: closed cases with their recorded overview and outcome ----

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const gist = (o: Case) => `${o.key} | ${o.title} | ${flat(o.answer.Overview ?? o.request).slice(0, 220)}`;

type Para = { id: string; src: string; text: string; low: string };
const paras = (o: Case): Para[] => [
  ...Object.entries(o.answer).map(([h, b]) => ({ id: o.key, src: h, text: flat(b) })),
  ...o.events.map((e) => ({ id: o.key, src: `event ${e.n} · ${e.channel} · ${e.from} → ${e.to}`, text: flat(e.body) })),
].map((x) => ({ ...x, low: x.text.toLowerCase() }));

// Keyword search: a word found in few paragraphs counts for more than one found in every claim.
export function searchClaims(others: Case[], query: string): string {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9£]{3,}/g) ?? [])];
  if (!terms.length) return "No claim found (empty query).";
  const all = others.flatMap(paras);
  const weight = new Map<string, number>();
  for (const t of terms) { const n = all.filter((x) => x.low.includes(t)).length; if (n) weight.set(t, Math.log(1 + all.length / n)); }
  const total = [...weight.values()].reduce((a, b) => a + b, 0);
  const score = (x: Para) => [...weight].reduce((a, [t, w]) => a + (x.low.includes(t) ? w : 0), 0);
  const hits: string[] = [], per = new Map<string, number>();
  for (const x of all.map((x) => ({ x, s: score(x) })).sort((a, b) => b.s - a.s)) {
    if (!total || x.s < 0.4 * total || hits.length === 8) break;
    if ((per.get(x.x.id) ?? 0) >= 2) continue; // at most two excerpts per claim
    per.set(x.x.id, (per.get(x.x.id) ?? 0) + 1);
    hits.push(`[${x.x.id} · ${x.x.src}] ${x.x.text.slice(0, 400)}`);
  }
  return hits.join("\n---\n") || `No claim found for "${query}".`;
}

export function readClaim(kit: Kit, others: Case[], id: string): string {
  const want = id.trim();
  const found = others.filter((o) => o.key === want || o.key.endsWith(`-${want}`));
  if (found.length !== 1) throw new Error(`NOT_FOUND: no claim "${want}". Use an id from the list.`);
  const o = found[0];
  const events = o.events.map((e) => `--- event ${e.n} · ${e.ts} UTC · ${e.channel} ---\nfrom: ${e.from}\nto: ${e.to}${e.subject ? `\nsubject: ${e.subject}` : ""}\n\n${e.body}`);
  return [caseFile(kit, o), ...Object.entries(o.answer).map(([h, b]) => `## ${h}\n\n${b}`), "## History", ...events].join("\n\n").slice(0, 20_000);
}
