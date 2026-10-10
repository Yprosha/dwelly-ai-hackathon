// The preset panel. The harness itself launches a fixed set of sub-agents before the agent's turn, each with a brief
// of its own: a web researcher, a conservative risk assessor, a creative problem-solver, a precedent analyst and a
// simplifier. The agent does not choose them. Their proposals are appended to the agent's input for that turn; the
// agent decides. Who can sit, with which brief and when, is config/panel.json; settings.panel picks them. They run
// as ordinary sub-agents (subagent.ts): same model preset, same tools, same limits.
import type { Ctx } from "./casefs.ts";
import { promptOf, render, type Call, type Kit } from "./llm.ts";
import { runSubagent, type Step } from "./subagent.ts";

export type PanelSpec = {
  title: string;
  prompt: string; // the sub-agent's angle, a file in prompts/
  when: "first" | "every"; // first: only when the agent picks the case up; every: before each of its turns
};

// Saved in the shape the earlier advisory council used, so the UI draws a sitting with the same fold and traces.
export type Proposal = {
  name: string; title: string; preset: string;
  status: "ok" | "failed";
  note?: string; // why there is no proposal
  proposal: string;
  input?: string; // what the sub-agent was shown
  steps: Step[];
  calls: Call[];
  cost: number; ms: number;
};

// One sitting of the panel. `text` is exactly what was appended to the agent's input for this turn.
export type Advice = { turn: number; proposals: Proposal[]; text: string };

export function checkPanel(kit: Kit) {
  const names = kit.settings.panel ?? [];
  for (const name of names) {
    const spec = kit.panel[name];
    if (!spec) throw new Error(`unknown panel member "${name}": config/panel.json has ${Object.keys(kit.panel).join(", ") || "none"}`);
    promptOf(kit, spec.prompt);
  }
  if (names.length) for (const f of ["panel.task.md", "agent.panel.md"]) promptOf(kit, f);
}

// Never throws: a sub-agent that fails only loses its own proposal.
export async function sitPanel(ctx: Ctx, turn: number): Promise<Advice | undefined> {
  const { kit } = ctx;
  const names = (kit.settings.panel ?? []).filter((n) => turn === 1 || kit.panel[n].when !== "first");
  if (!names.length) return;
  const task = (n: string) => render(promptOf(kit, "panel.task.md"), { lens: promptOf(kit, kit.panel[n].prompt).trim() });
  const runs = await Promise.all(names.map((n) => runSubagent(ctx, `panel:${n}`, turn, task(n))));
  const proposals = runs.map((s, i): Proposal => ({
    name: names[i], title: kit.panel[names[i]].title, preset: kit.settings.subagent,
    status: s.error ? "failed" : "ok", ...(s.error ? { note: s.error } : {}),
    proposal: s.report.slice(Math.max(s.report.indexOf("PROPOSAL"), 0)),
    input: s.input, steps: s.steps, calls: s.calls, cost: s.cost, ms: s.ms,
  }));
  const list = proposals.map((p, i) => (p.status === "ok" ? `### ${i + 1}. ${p.title}\n\n${p.proposal}` : `### ${i + 1}. ${p.title}\n\nNo proposal (${p.note}).`));
  return { turn, proposals, text: render(promptOf(kit, "agent.panel.md"), { proposals: list.join("\n\n") }) };
}
