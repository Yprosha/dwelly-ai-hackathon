// Config, prompts and the one place that calls Claude.
// Everything model-facing lives in prompts/ and config/. A run loads them once into a Kit, so edits made in the UI
// apply to the next run and every run keeps a snapshot of exactly what it used.
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const readJson = <T = any>(rel: string): T => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

// research/case-lab/.env first, then the repo's root .env; values already set win.
export function loadEnv() {
  const repo = path.resolve(ROOT, "../..");
  for (const f of [path.join(ROOT, ".env"), fs.existsSync(path.join(repo, ".git")) && path.join(repo, ".env")])
    if (f && fs.existsSync(f)) process.loadEnvFile(f);
}

export type Settings = {
  agent: string; simulator: string; judge: string; extractor: string; // model preset names from config/models.json
  seedEvents: number; // 0: the simulator opens the case; N: hand the agent the first N real events verbatim
  maxWorldTurns: number; maxToolRounds: number; concurrency: number;
  runJudge: boolean; hiddenDetails: string[];
};

export type Kit = {
  settings: Settings;
  models: Record<string, Record<string, unknown>>;
  pricing: Record<string, [number, number]>;
  prompts: Record<string, string>; // file name -> contents, every file in prompts/
};

export function loadKit(overrides: Partial<Settings> = {}): Kit {
  const dir = path.join(ROOT, "prompts");
  return {
    settings: { ...readJson<Settings>("config/settings.json"), ...overrides },
    models: readJson("config/models.json"),
    pricing: readJson("config/pricing.json"),
    prompts: Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")])),
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
  role: "agent" | "simulator" | "judge" | "extractor",
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
  const cost = ((u.input_tokens + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0)) * inp + u.output_tokens * out) / 1e6;
  return { message, call: { role, preset, model: message.model, ms: Date.now() - t, usage: u, stop_reason: message.stop_reason, cost } };
}

export const textOf = (m: Anthropic.Beta.BetaMessage) => m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

// Structured output is schema-valid unless the turn was cut short.
export function jsonOf<T>(m: Anthropic.Beta.BetaMessage): T {
  if (m.stop_reason === "refusal" || m.stop_reason === "max_tokens") throw new Error(`no structured output (stop_reason=${m.stop_reason})`);
  return JSON.parse(textOf(m));
}
