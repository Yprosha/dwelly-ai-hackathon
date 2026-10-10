// Runs cases end to end and stores everything the UI shows under runs/<id>/ (run.json + cases/<key>.json).
import fs from "node:fs";
import path from "node:path";
import { allCases, getCase, handlerNames, type Case } from "./cases.ts";
import { agentTurn, newAgent, type AgentState } from "./agent.ts";
import { advise, checkAdvisers, type Advice } from "./council.ts";
import { agentBrief, caseFile, docText, renderMsg, visibleDocs, type Ctx, type Msg } from "./casefs.ts";
import { renderEvent, renderReplay, seed, worldTurn, type Offense, type WorldTurn } from "./simulator.ts";
import { ROOT, call, jsonOf, jsonPrompt, loadKit, promptOf, readJson, render, type Call, type Kit, type Settings } from "./llm.ts";

export type Judgement = {
  first_action: { verdict: "match" | "partial" | "miss"; reason: string };
  acts: { party: string; act: string; covered: boolean; evidence: string }[];
  extras: { party: string; act: string; problem: boolean; note: string }[];
  violations: { quote: string; explanation: string }[];
  end_to_end?: { verdict: "correct" | "incorrect"; reason: string }; // the whole replay; absent in runs judged before this verdict existed
  summary: string;
};

export type CaseResult = {
  key: string;
  status: "done" | "error";
  error?: string;
  stop: string; // closed | silence | turn limit | over-request | extra-message | error
  failure?: Offense & { turn: number }; // the agent message that ended the run, when settings.failOn caught one
  start: "escalation" | "seed" | "opening"; // how the takeover point was chosen (absent in runs made before escalation starts)
  takeover: number; // last real event the agent had seen when it first acted
  handler: string[]; // names the handler's side goes by in the real case (from the simulator)
  replay: Msg[];
  agent: AgentState;
  advice?: Advice[]; // what the advisers proposed before each agent turn (absent in runs made before the council)
  world: WorldTurn[];
  judge?: { output: Judgement; prompt: string; call: Call };
  extract: Call[];
  cost: number;
  ms: number;
};

export type CaseSummary = {
  status: "pending" | "running" | "done" | "error";
  stop?: string; error?: string; cost?: number; sent?: number; closed?: boolean; failed?: string;
  firstAction?: string; acts?: [number, number]; violations?: number;
  e2e?: boolean; // the judge's end-to-end verdict: the whole replay is correct and follows the real case
};

export type RunMeta = { id: string; label: string; createdAt: string; finishedAt?: string; status: "running" | "done"; kit: Kit; cases: Record<string, CaseSummary> };

const RUNS = path.join(ROOT, "runs");

export async function runCase(kit: Kit, c: Case): Promise<CaseResult> {
  const t0 = Date.now();
  const s = kit.settings;
  const res: CaseResult = { key: c.key, status: "done", stop: "", start: "opening", takeover: 0, handler: [], replay: [], agent: newAgent(kit), advice: [], world: [], extract: [], cost: 0, ms: 0 };
  const { replay, agent, world } = res;
  const ctx: Ctx = { kit, c, replay, handler: res.handler, extract: res.extract };
  try {
    // Where the agent takes over. An explicit seedEvents wins; otherwise the case's escalation point: the agent is
    // handed every real event up to it, verbatim, and nothing that came after. Without either, the simulator opens.
    const esc = s.startAt === "escalation" ? Math.min(kit.escalation[c.key]?.after ?? 0, c.events.length) : 0;
    const handover = s.seedEvents > 0 ? Math.min(s.seedEvents, c.events.length) : esc;
    if (handover > 0) {
      res.start = s.seedEvents > 0 ? "seed" : "escalation";
      ctx.handler = handlerNames(c);
      seed(ctx, handover);
    } else world.push(await worldTurn(ctx, [], 0)); // the simulator delivers everything before the handler first wrote to anyone
    if (!replay.length) throw new Error("the simulator delivered no opening messages");
    res.takeover = Math.max(0, ...replay.flatMap((m) => m.follows));

    let input = render(promptOf(kit, "agent.kickoff.md"), {
      case_file: agentBrief(kit, c),
      messages: replay.map(renderMsg).join("\n\n"),
      documents: visibleDocs(ctx).map((d) => `/documents/${d}`).join("\n") || "(none)",
    });
    let silent = false;
    let latest = replay.map((m) => m.n); // the messages the agent has not responded to yet
    for (let turn = 1; ; turn++) {
      // the council sits first: its proposals go to the agent with this turn's input, and the agent decides
      const advice = await advise(ctx, latest, turn);
      if (advice) res.advice!.push(advice);
      const before = replay.length;
      const docsBefore = visibleDocs(ctx);
      await agentTurn(ctx, agent, input + (advice?.text ?? ""), turn);
      if (agent.closed) { res.stop = "closed"; break; }
      if (turn > s.maxWorldTurns) { res.stop = "turn limit"; break; }
      const w = await worldTurn(ctx, replay.slice(before), turn);
      world.push(w);
      if (w.offenses.length) { res.failure = { ...w.offenses[0], turn }; res.stop = w.offenses[0].verdict.replace("_", "-"); break; }
      latest = w.delivered;
      if (w.delivered.length) {
        silent = false;
        const attached = new Set(w.delivered.flatMap((n) => replay[n - 1].attachments));
        const fresh = visibleDocs(ctx).filter((d) => !docsBefore.includes(d) && !attached.has(d));
        input = render(promptOf(kit, "agent.update.md"), {
          messages: w.delivered.map((n) => renderMsg(replay[n - 1])).join("\n\n"),
          documents: fresh.length ? `\nNow also on file:\n${fresh.map((d) => `/documents/${d}`).join("\n")}` : "",
        });
      } else if (silent) { res.stop = "silence"; break; }
      else { silent = true; input = promptOf(kit, "agent.silence.md"); } // one notice, like claimsorted's silence signal
    }
    if (s.runJudge) res.judge = await judge(ctx, res);
  } catch (e) {
    res.status = "error";
    res.error = e instanceof Error ? e.message : String(e);
    res.stop ||= "error";
  }
  res.handler = ctx.handler; // set by the first world turn
  const advisers = res.advice!.flatMap((a) => a.proposals.flatMap((p) => p.calls));
  res.cost = [...agent.calls, ...advisers, ...world.map((w) => w.call), ...(res.judge ? [res.judge.call] : []), ...res.extract].reduce((a, x) => a + x.cost, 0);
  res.ms = Date.now() - t0;
  return res;
}

// The judge sees what the agent could rely on: the events before the takeover, the replay, and the text of every
// document the agent held by the end (as extracted for the agent). Without the documents it takes a figure or a
// name the agent read in an attachment for an invented one.
export async function judge(ctx: Ctx, res: CaseResult) {
  const { kit, c } = ctx;
  const docs: string[] = [];
  for (const name of visibleDocs(ctx)) docs.push(`### /documents/${name}\n\n${await docText(ctx, name)}`);
  const card = kit.settings.caseCard ?? "full";
  const unseen = card === "full" ? "" : `\n\n(The agent was not shown this case card. It was told only who it is${card === "record" ? ", plus the broker, insurer and property on record" : ""}; everything else it knew came from the events before the takeover.)`;
  const prompt = render(promptOf(kit, "judge.user.md"), {
    case_file: caseFile(kit, c) + unseen,
    answer_key: Object.entries(c.answer).map(([h, b]) => `### ${h}\n\n${b}`).join("\n\n") || "(none)",
    context_events: c.events.filter((e) => e.n <= res.takeover).map((e) => renderEvent(c, e)).join("\n\n") || "(none)",
    real_events: c.events.filter((e) => e.n > res.takeover).map((e) => renderEvent(c, e)).join("\n\n") || "(none)",
    replay: res.replay.filter((m) => m.turn > 0).map(renderReplay).join("\n\n") || "(the agent did nothing)",
    documents: docs.join("\n\n") || "(none)",
    agent_outcome: res.agent.closed?.outcome ?? `(not closed; the run ended by ${res.stop})`,
  });
  const r = await call(kit, "judge", { system: promptOf(kit, "judge.system.md"), messages: [{ role: "user", content: prompt }], schema: jsonPrompt(kit, "judge.schema.json") });
  return { output: jsonOf<Judgement>(r.message), prompt, call: r.call };
}

const summarize = (r: CaseResult): CaseSummary => ({
  status: r.status, stop: r.stop, error: r.error, cost: r.cost,
  sent: r.replay.filter((m) => m.author === "agent" && m.kind === "message").length,
  closed: Boolean(r.agent.closed),
  failed: r.failure?.verdict,
  firstAction: r.judge?.output.first_action.verdict,
  acts: r.judge ? [r.judge.output.acts.filter((a) => a.covered).length, r.judge.output.acts.length] : undefined,
  violations: r.judge?.output.violations.length,
  e2e: r.judge?.output.end_to_end ? r.judge.output.end_to_end.verdict === "correct" : undefined,
});

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, queue.length)) }, async () => { while (queue.length) await fn(queue.shift()!); }));
}

export function selectKeys(sel: { split?: string; tracks?: string[]; keys?: string[] }): string[] {
  if (sel.keys?.length) return sel.keys;
  const splits = readJson<Record<string, string[]>>("config/splits.json");
  const keys = sel.split && sel.split !== "all" ? splits[sel.split] : allCases().map((c) => c.key);
  if (!keys) throw new Error(`unknown split "${sel.split}"`);
  return keys.filter((k) => !sel.tracks?.length || sel.tracks.includes(k.split("-")[0]));
}

export function startRun(opts: { label?: string; keys: string[]; overrides?: Partial<Settings> }, onCase?: (key: string, s: CaseSummary) => void) {
  const kit = loadKit(opts.overrides);
  checkAdvisers(kit);
  const cases = opts.keys.map(getCase);
  if (!cases.length) throw new Error("no cases selected");
  const label = opts.label?.trim() || "run";
  const id = `${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const dir = path.join(RUNS, id);
  fs.mkdirSync(path.join(dir, "cases"), { recursive: true });
  const meta: RunMeta = { id, label, createdAt: new Date().toISOString(), status: "running", kit, cases: Object.fromEntries(cases.map((c) => [c.key, { status: "pending" }])) };
  const save = () => fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(meta, null, 2));
  save();
  const done = pool(cases, kit.settings.concurrency, async (c) => {
    meta.cases[c.key] = { status: "running" };
    save();
    const r = await runCase(kit, c);
    fs.writeFileSync(path.join(dir, "cases", `${c.key}.json`), JSON.stringify(r, null, 2));
    meta.cases[c.key] = summarize(r);
    save();
    onCase?.(c.key, meta.cases[c.key]);
  }).then(() => {
    meta.status = "done";
    meta.finishedAt = new Date().toISOString();
    save();
    return meta;
  });
  return { id, done };
}

// ponytail: a run interrupted by a server restart stays "running" on disk; mark it by hand or rerun
export function listRuns() {
  if (!fs.existsSync(RUNS)) return [];
  return fs.readdirSync(RUNS).filter((d) => fs.existsSync(path.join(RUNS, d, "run.json"))).sort().reverse().map((d) => {
    const { kit, ...rest } = readJson<RunMeta>(`runs/${d}/run.json`);
    return { ...rest, settings: kit.settings };
  });
}

export const getRun = (id: string) => readJson<RunMeta>(`runs/${path.basename(id)}/run.json`);
export const getCaseResult = (id: string, key: string) => readJson<CaseResult>(`runs/${path.basename(id)}/cases/${path.basename(key)}.json`);
