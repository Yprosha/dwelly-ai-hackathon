// Config, prompts and the one place that calls Claude.
// Everything model-facing lives in prompts/ and config/. A run loads them once into a Kit, so edits made in the UI
// apply to the next run and every run keeps a snapshot of exactly what it used.
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import type { PanelSpec } from "./panel.ts";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const readJson = <T = any>(rel: string): T => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

// research/case-lab/.env first, then the repo's root .env; values already set win.
export function loadEnv() {
  const repo = path.resolve(ROOT, "../..");
  for (const f of [path.join(ROOT, ".env"), fs.existsSync(path.join(repo, ".git")) && path.join(repo, ".env")])
    if (f && fs.existsSync(f)) process.loadEnvFile(f);
}

export type Settings = {
  agent: string; simulator: string; judge: string; reviewer: string; extractor: string; subagent: string; // model preset names from config/models.json
  caseCard: "none" | "record" | "full"; // what the agent is told from index.md: only who it is / + broker, insurer, property / the whole card
  startAt: "escalation" | "opening"; // escalation: the agent takes over at the case's escalation point (config/escalation.json); opening: at the start
  seedEvents: number; // 0: follow startAt; N: hand the agent the first N real events verbatim, whatever startAt says
  maxWorldTurns: number; maxToolRounds: number; concurrency: number;
  subagents?: boolean; // the agent has run_subagent (absent in kits saved before it existed)
  panel?: string[]; // names from config/panel.json the harness launches before the agent's turns; empty or absent: no panel
  runJudge: boolean; runReviewer: boolean; hiddenDetails: string[];
  failOn: string[]; // simulator verdicts that end a run as failed: over_request, extra_message
};

export type Kit = {
  settings: Settings;
  models: Record<string, Record<string, unknown>>;
  pricing: Record<string, [number, number]>;
  panel: Record<string, PanelSpec>; // config/panel.json: the preset sub-agents that can sit (absent in kits saved before it existed)
  prompts: Record<string, string>; // file name -> contents, every file in prompts/
  escalation: Record<string, { after: number; trigger?: string }>; // case key -> last real event before its escalation point
};

export function loadKit(overrides: Partial<Settings> = {}): Kit {
  const dir = path.join(ROOT, "prompts");
  return {
    settings: { ...readJson<Settings>("config/settings.json"), ...overrides },
    models: readJson("config/models.json"),
    pricing: readJson("config/pricing.json"),
    panel: fs.existsSync(path.join(ROOT, "config/panel.json")) ? readJson("config/panel.json") : {},
    prompts: Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")])),
    escalation: fs.existsSync(path.join(ROOT, "config/escalation.json")) ? readJson("config/escalation.json") : {},
  };
}

export function promptOf(kit: Kit, name: string): string {
  const p = kit.prompts[name];
  if (p === undefined) throw new Error(`prompts/${name} is missing`);
  return p;
}
export const jsonPrompt = <T = any>(kit: Kit, name: string): T => JSON.parse(promptOf(kit, name));

export function render(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`template variable {{${k}}} has no value`);
    return String(vars[k]);
  });
}

export type Call = { role: string; preset: string; model: string; ms: number; usage: Anthropic.Beta.BetaUsage; stop_reason: string | null; cost: number };

let client: Anthropic | undefined; // lazy: entrypoints load .env first

export async function call(
  kit: Kit,
  role: "agent" | "simulator" | "judge" | "reviewer" | "extractor" | "subagent",
  req: { system: string; messages: Anthropic.Beta.BetaMessageParam[]; tools?: unknown[]; toolChoiceNone?: boolean; schema?: object },
): Promise<{ message: Anthropic.Beta.BetaMessage; call: Call }> {
  const preset = kit.settings[role];
  const params = kit.models[preset];
  if (!params) throw new Error(`model preset "${preset}" (${role}) is not in config/models.json`);
  const body: any = { ...params, system: req.system, messages: req.messages };
  if (req.tools) body.tools = req.tools;
  if (req.toolChoiceNone) body.tool_choice = { type: "none" };
  if (req.schema) body.output_config = { ...(params.output_config as object), format: { type: "json_schema", schema: req.schema } };
  client ??= new Anthropic({ maxRetries: 4 });
  const t = Date.now();
  const message = await client.beta.messages.stream(body).finalMessage();
  const u = message.usage;
  const [inp, out] = kit.pricing[message.model] ?? [0, 0];
  // cache writes cost 1.25x input, cache reads 0.1x
  const cost = ((u.input_tokens + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0)) * inp + u.output_tokens * out) / 1e6
    + 0.01 * (u.server_tool_use?.web_search_requests ?? 0); // server-side web search: $10 per 1,000 searches
  return { message, call: { role, preset, model: message.model, ms: Date.now() - t, usage: u, stop_reason: message.stop_reason, cost } };
}

export const textOf = (m: Anthropic.Beta.BetaMessage) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

// Structured output is schema-valid unless the turn was cut short.
export function jsonOf<T>(m: Anthropic.Beta.BetaMessage): T {
  if (m.stop_reason === "refusal" || m.stop_reason === "max_tokens") throw new Error(`no structured output (stop_reason=${m.stop_reason})`);
  return JSON.parse(textOf(m));
}
