// The advisory council. Before the agent takes a turn, sub-agents with different settings each propose the next steps
// from their own angle: a creative one, a conservative risk assessor, a web researcher (UK guidance), a policy-wording
// researcher (UK insurers' wordings for the same kind of policy) and a precedent analyst (how other claims in the
// database were handled). The proposals are appended to the agent's input for that turn; the agent decides.
// Who sits on it, with which model preset, prompt and tools, is config/advisers.json; settings.advisers picks them.
import type Anthropic from "@anthropic-ai/sdk";
import { allCases, type Case } from "./cases.ts";
import { agentBrief, caseFile, extract, fsTool, pad, renderMsg, visibleDocs, type Ctx } from "./casefs.ts";
import { call, jsonPrompt, promptOf, render, type Call, type Kit } from "./llm.ts";

export type AdviserSpec = {
  title: string;
  preset: string; // model preset from config/models.json: this is where advisers differ in model and effort
  prompt: string; // the adviser's angle, a file in prompts/
  tools: ("case" | "web" | "claims")[]; // groups from prompts/adviser.tools.json
  when: "first" | "every"; // first: only when the agent picks the case up; every: before each of its turns
};

// What an adviser did, in order: what it said between tool calls, the tools it called and what came back. Enough for
// the UI to replay its work the way it shows the agent's own chat. The content of web pages is not kept.
export type ToolStep = { name: string; input: unknown; result?: string; error?: boolean; links?: { title: string; url: string }[] };
export type Step = { text: string } | ToolStep;

export type Proposal = {
  name: string; title: string; preset: string;
  status: "ok" | "failed";
  note?: string; // why there is no proposal
  proposal: string;
  input?: string; // what the adviser was shown (absent in runs made before traces were kept)
  steps: Step[];
  calls: Call[];
  cost: number; ms: number;
};

// One sitting of the council. `text` is exactly what was appended to the agent's input for this turn.
export type Advice = { turn: number; proposals: Proposal[]; text: string };

const MAX_ROUNDS = 8; // model rounds per adviser; the last one has no tools, so it always ends in a proposal
const MAX_KEEP = 30_000; // characters of one tool result kept in the trace
const DEADLINE_MS = 300_000; // an adviser still working after this is reported as failed and the turn goes on

export function checkAdvisers(kit: Kit) {
  for (const name of kit.settings.advisers ?? []) {
    const spec = kit.advisers[name];
    if (!spec) throw new Error(`unknown adviser "${name}": config/advisers.json has ${Object.keys(kit.advisers).join(", ") || "none"}`);
    if (!kit.models[spec.preset]) throw new Error(`adviser "${name}": model preset "${spec.preset}" is not in config/models.json`);
    promptOf(kit, spec.prompt);
  }
}

// Never throws: an adviser that fails only loses its own proposal.
export async function advise(ctx: Ctx, latest: number[], turn: number): Promise<Advice | undefined> {
  const { kit } = ctx;
  const names = (kit.settings.advisers ?? []).filter((n) => turn === 1 || kit.advisers[n].when !== "first");
  if (!names.length) return;
  // read each attachment once here (cached afterwards), not once per adviser
  for (const d of visibleDocs(ctx)) await extract(ctx, d).catch(() => undefined);
  const proposals = await Promise.all(names.map((n) => runAdviser(ctx, n, latest)));
  const list = proposals.map((p, i) => (p.status === "ok" ? `### ${i + 1}. ${p.title}\n\n${p.proposal}` : `### ${i + 1}. ${p.title}\n\nNo proposal (${p.note}).`));
  return { turn, proposals, text: render(promptOf(kit, "agent.advice.md"), { proposals: list.join("\n\n") }) };
}

async function runAdviser(ctx: Ctx, name: string, latest: number[]): Promise<Proposal> {
  const { kit, c, replay } = ctx;
  const spec = kit.advisers[name];
  const t0 = Date.now();
  const p: Proposal = { name, title: spec.title, preset: spec.preset, status: "ok", proposal: "", steps: [], calls: [], cost: 0, ms: 0 };
  let late = false;
  const work = async () => {
    const groups = jsonPrompt<{ case: string[]; web: unknown[]; claims: unknown[] }>(kit, "adviser.tools.json");
    const caseTools = jsonPrompt<{ name: string }[]>(kit, "tools.json").filter((t) => groups.case.includes(t.name));
    const tools = spec.tools.flatMap((g) => (g === "case" ? caseTools : groups[g]));
    const others = spec.tools.includes("claims") ? allCases().filter((o) => o.key !== c.key) : []; // never the case itself
    const system = render(promptOf(kit, "adviser.system.md"), { lens: promptOf(kit, spec.prompt).trim() });
    const user = render(promptOf(kit, "adviser.user.md"), {
      case_file: agentBrief(kit, c),
      messages: replay.map(renderMsg).join("\n\n"),
      documents: visibleDocs(ctx).map((d) => `/documents/${d}`).join("\n") || "(none)",
      latest: latest.map((n) => `/messages/${pad(n)}`).join(", ") || "(none)",
    }) + (others.length ? render(promptOf(kit, "adviser.claims.md"), { catalogue: others.map(gist).join("\n") }) : "");
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: user }];
    p.input = user;
    const pending = new Map<string, ToolStep>(); // server-side tool calls waiting for their result block
    for (let round = 1; round <= MAX_ROUNDS && !late; round++) {
      const { message, call: meta } = await call(kit, "adviser", { preset: spec.preset, system, messages, tools: tools.length ? tools : undefined, toolChoiceNone: tools.length > 0 && round === MAX_ROUNDS });
      if (late) return; // timed out while this call was in flight: its result is dropped
      p.calls.push(meta);
      messages.push({ role: "assistant", content: message.content });
      const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const paused = message.stop_reason === "pause_turn";
      // the answer is the text after the last tool block of the last message; any text before that is said along the way
      const last = message.content.findLastIndex((b) => b.type !== "text" && b.type !== "thinking" && b.type !== "redacted_thinking");
      message.content.forEach((b, i) => {
        const id = (b as { tool_use_id?: unknown }).tool_use_id;
        if (b.type === "text") { if (b.text.trim() && (uses.length || paused || i < last)) p.steps.push({ text: b.text.trim() }); }
        else if (b.type === "server_tool_use") { const s: ToolStep = { name: b.name, input: b.input }; p.steps.push(s); pending.set(b.id, s); }
        else if (typeof id === "string" && pending.has(id)) Object.assign(pending.get(id)!, serverResult((b as { content?: unknown }).content));
      });
      if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") throw new Error(`adviser stopped: ${message.stop_reason}`);
      if (paused) continue; // a long server-side tool loop paused: sent again as is, it resumes
      if (!uses.length) {
        const text = message.content.slice(last + 1).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
        p.proposal = text.slice(Math.max(text.indexOf("PROPOSAL"), 0));
        break;
      }
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        const input = u.input as any;
        let content: string, failed = false;
        try {
          content = u.name === "search_claims" ? searchClaims(kit, others, String(input?.query ?? ""))
            : u.name === "read_claim" ? readClaim(kit, others, String(input?.claim_id ?? ""))
            : await fsTool(ctx, u.name, input);
        } catch (e) { content = e instanceof Error ? e.message : String(e); failed = true; }
        p.steps.push({ name: u.name, input, result: content.slice(0, MAX_KEEP), ...(failed ? { error: true } : {}) });
        results.push({ type: "tool_result", tool_use_id: u.id, content, ...(failed ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
    if (!p.proposal) throw new Error("no proposal produced");
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([work(), new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`no proposal within ${DEADLINE_MS / 1000}s`)), DEADLINE_MS); })]);
  } catch (e) {
    p.status = "failed";
    p.proposal = "";
    p.note = e instanceof Error ? e.message : String(e);
  }
  late = true; // a timed-out adviser stops when its call in flight returns
  clearTimeout(timer);
  p.cost = p.calls.reduce((a, x) => a + x.cost, 0);
  p.ms = Date.now() - t0;
  return p;
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

// ---- the other claims on the books: closed cases with their recorded overview and outcome ----

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const gist = (o: Case) => `${o.key} | ${o.title} | ${flat(o.answer.Overview ?? o.request).slice(0, 220)}`;

type Para = { id: string; src: string; text: string; low: string };
const paras = (o: Case): Para[] => [
  ...Object.entries(o.answer).map(([h, b]) => ({ id: o.key, src: h, text: flat(b) })),
  ...o.events.map((e) => ({ id: o.key, src: `event ${e.n} · ${e.channel} · ${e.from} → ${e.to}`, text: flat(e.body) })),
].map((x) => ({ ...x, low: x.text.toLowerCase() }));

// Keyword search: a word found in few paragraphs counts for more than one found in every claim.
export function searchClaims(_kit: Kit, others: Case[], query: string): string {
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
  const events = o.events.map((e) => `--- event ${e.n} · ${e.ts} UTC · ${e.channel} ---\nfrom: ${e.from}\nto: ${e.to}\n\n${e.body}`);
  return [caseFile(kit, o), ...Object.entries(o.answer).map(([h, b]) => `## ${h}\n\n${b}`), "## History", ...events].join("\n\n").slice(0, 20_000);
}
