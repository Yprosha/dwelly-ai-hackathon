// The deliverable for a folder of handed cases: <out>/<case>/ANSWER.md and REASONING.md, plus the full trace as
// <logs>/<case>.json. Everything is rendered from the finished case run; nothing here calls a model.
import fs from "node:fs";
import path from "node:path";
import type { Case } from "./cases.ts";
import type { Kit } from "./llm.ts";
import type { CaseResult } from "./run.ts";

export type Out = { answers: string; logs: string };

const quote = (s: string) => s.trim().split("\n").map((l) => `> ${l}`).join("\n");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + " […]" : s).trim();
const inline = (s: string, n: number) => clip(s.replace(/\s+/g, " "), n);

function actions(r: CaseResult): string {
  const acts = r.replay.filter((m) => m.author === "agent").map((m, i) => m.kind === "note"
    ? `### ${i + 1}. Note on the case record\n\n${quote(m.body)}`
    : `### ${i + 1}. ${m.channel} to ${m.to}${m.subject ? `: ${m.subject}` : ""}\n\n${quote(m.body)}${m.attachments.length ? `\n\nAttached: ${m.attachments.join(", ")}` : ""}`);
  if (r.agent.closed) acts.push(`### ${acts.length + 1}. Case closed\n\n${quote(r.agent.closed.outcome)}`);
  return acts.join("\n\n") || "None: the agent sent nothing and recorded nothing at this point.";
}

export function answerMd(c: Case, r: CaseResult): string {
  const name = c.handed?.name ?? c.id;
  const head = c.title === name ? `# Case ${name}` : `# Case ${name}: ${c.title}`; // a case without index.md has no title
  const result = r.answer
    ? `## Overview\n\n${r.answer.overview}\n\n## Next action at escalation\n\n${r.answer.next_action}`
    : `## Result\n\nThe system did not finish this case${r.error ? ` (${r.error})` : ""}, so it wrote no answer. The case needs a human handler. Anything listed below was issued before the failure.`;
  return `${head}\n\n${result}\n\n## Actions taken\n\nWhat the agent did through its tools at this point, in order and word for word. No live mailbox is connected, so each message is recorded, not delivered.\n\n${actions(r)}\n`;
}

// The agent's own conversation, step by step: what it read, searched, asked a sub-agent, sent, and what came back as an error.
function trace(kit: Kit, r: CaseResult): { lines: string[]; failed: string[]; opened: Set<string> } {
  const lines: string[] = [], failed: string[] = [], opened = new Set<string>();
  const label = new Map<string, string>();
  for (const m of r.agent.messages) {
    if (typeof m.content === "string") {
      if (m.content === kit.prompts["agent.answer.md"]) { lines.push("- Asked for its answer (Overview, Next action at escalation): see ANSWER.md."); break; }
      continue; // the handover itself is described under "What the system received"
    }
    for (const b of m.content as any[]) {
      if (b.type === "thinking" && b.thinking?.trim()) lines.push(`- *Thinking (model summary):* ${inline(b.thinking, 1500)}`);
      else if (b.type === "text" && b.text?.trim()) lines.push(`- **Agent:** ${inline(b.text, 2000)}`);
      else if (b.type === "tool_use") {
        const i = b.input ?? {};
        const what = b.name === "search_case" ? `/${i.pattern}/ in ${i.path ?? "/"}` : b.name === "send_message" ? `to ${i.to}` : b.name === "run_subagent" ? inline(String(i.instruction ?? ""), 300) : String(i.path ?? "");
        label.set(b.id, `${b.name} ${what}`.trim());
        if (b.name === "read_case" && String(i.path ?? "").includes("/documents/")) opened.add(String(i.path).replace(/^.*\/documents\//, ""));
        lines.push(`- \`${b.name}\` ${what}`.trimEnd());
      } else if (b.type === "tool_result" && b.is_error) {
        const why = inline(typeof b.content === "string" ? b.content : JSON.stringify(b.content), 400);
        lines.push(`  - failed: ${why}`);
        failed.push(`\`${label.get(b.tool_use_id) ?? "tool call"}\`: ${why}`);
      }
    }
  }
  return { lines, failed, opened };
}

export function reasoningMd(kit: Kit, c: Case, r: CaseResult, runId: string, traceFile: string): string {
  const { lines, failed, opened } = trace(kit, r);
  const history = r.replay.filter((m) => m.turn === 0);
  const s = kit.settings;
  const parts = [
    `# Case ${c.handed?.name ?? c.id}: reasoning and trace`,
    "Written by the system from its own run record. Nothing here was edited by hand.",
    "## What the system received",
    [
      `- Case folder \`${c.handed?.name ?? c.id}\`: ${c.title}`,
      `- History handed to the agent: ${history.length} message(s)${history.length ? `; the first from ${inline(history[0].from, 60)}${history[0].ts ? ` (${history[0].ts} UTC)` : ""}, the last from ${inline(history[history.length - 1].from, 60)}${history[history.length - 1].ts ? ` (${history[history.length - 1].ts} UTC)` : ""}` : ""}`,
      `- Documents on file: ${c.attachments.length ? c.attachments.map((a) => `\`${a.name}\` (${opened.has(a.name) ? "opened by the agent" : "not opened by the agent itself"})`).join(", ") : "none"}`,
      ...(c.handed?.notes ?? []).map((n) => `- Note: ${n}`),
    ].join("\n"),
    ...(r.answer?.reasoning ? ["## Why: the agent's own reasoning", r.answer.reasoning] : []),
    "## What it did, step by step",
    lines.join("\n") || "(the agent took no step)",
  ];
  for (const a of r.advice ?? []) {
    parts.push(`## Preset panel before turn ${a.turn}`, a.proposals.map((p) => `### ${p.title}\n\n${p.status === "ok" ? clip(p.proposal, 4000) : `No proposal: ${p.note ?? "failed"}`}`).join("\n\n"));
  }
  if (r.agent.subagents.length) {
    parts.push("## Sub-agents the agent launched", r.agent.subagents.map((x, i) => `### Sub-agent ${i + 1}\n\n**Task:** ${clip(x.instruction, 1500)}\n\n**Report:** ${x.error ? `none (${x.error})` : clip(x.report, 4000)}`).join("\n\n"));
  }
  const problems = [
    ...(r.firstError ? [`A first attempt at this case failed (${r.firstError}); this is the result of the second attempt.`] : []),
    ...(r.error ? [`The run ended with an error: ${r.error}`] : []),
    ...failed.map((f) => `Tool call ${f}`),
    ...(r.advice ?? []).flatMap((a) => a.proposals.filter((p) => p.status !== "ok").map((p) => `Panel member ${p.title} gave no proposal: ${p.note ?? "failed"}`)),
  ];
  parts.push("## What failed", problems.length ? problems.map((p) => `- ${p}`).join("\n") : "Nothing failed.");
  parts.push("## Run", [
    `- Result: ${r.status === "done" ? "completed" : "error"}; the run stopped by "${r.stop}"`,
    `- Models: agent \`${r.agent.calls[0]?.model ?? s.agent}\` (preset ${s.agent})${s.subagents ? `, sub-agents on (preset ${s.subagent})` : ", sub-agents off"}${s.panel?.length ? `, preset panel: ${s.panel.join(", ")}` : ""}`,
    `- ${r.agent.calls.length} agent model call(s), about $${r.cost.toFixed(2)}, ${Math.round(r.ms / 1000)} s`,
    `- Full trace (every prompt, model call, tool call and result): \`${traceFile}\`; run \`${runId}\``,
  ].join("\n"));
  return parts.join("\n\n") + "\n";
}

// Never let one case's rendering stop the others: a case always gets both files.
export function writeOut(out: Out, kit: Kit, c: Case, r: CaseResult, runId: string) {
  const name = c.handed?.name ?? c.key;
  const dir = path.join(out.answers, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(out.logs, { recursive: true });
  const traceFile = path.join(out.logs, `${name}.json`);
  fs.writeFileSync(traceFile, JSON.stringify(r, null, 2));
  const safe = (file: string, fn: () => string) => {
    let text: string;
    try { text = fn(); } catch (e) { text = `# Case ${name}\n\nThis file could not be rendered (${e instanceof Error ? e.message : e}). The run record is in \`${path.basename(traceFile)}\`.\n`; }
    fs.writeFileSync(path.join(dir, file), text);
  };
  safe("ANSWER.md", () => answerMd(c, r));
  safe("REASONING.md", () => reasoningMd(kit, c, r, runId, path.join(path.basename(out.logs), `${name}.json`)));
}
