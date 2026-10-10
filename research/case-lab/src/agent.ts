// One agent turn: model rounds with tools until the agent ends its turn, closes the case, or runs out of rounds.
// The conversation is append-only (thinking blocks are passed back untouched), so it doubles as the trace.
import type Anthropic from "@anthropic-ai/sdk";
import { fsTool, pad, push, visibleDocs, type Ctx } from "./casefs.ts";
import { call, jsonOf, jsonPrompt, promptOf, type Call, type Kit } from "./llm.ts";

export type AgentState = {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  calls: (Call & { turn: number; round: number })[];
  closed?: { outcome: string; turn: number };
};

export const newAgent = (kit: Kit): AgentState => ({ system: promptOf(kit, "agent.system.md"), messages: [], calls: [] });

export type Answer = { overview: string; next_action: string };

// The deliverable: the agent's Overview and Next action at escalation, written in the same conversation right after
// its first turn, so it is decided at the escalation point and before any simulated reply.
export async function writeAnswer(ctx: Ctx, st: AgentState, turn: number): Promise<Answer> {
  const { kit } = ctx;
  st.messages.push({ role: "user", content: promptOf(kit, "agent.answer.md") });
  const { message, call: meta } = await call(kit, "agent", { system: st.system, messages: st.messages, tools: jsonPrompt(kit, "tools.json"), toolChoiceNone: true, schema: jsonPrompt(kit, "answer.schema.json") });
  st.calls.push({ ...meta, turn, round: 0 });
  st.messages.push({ role: "assistant", content: message.content });
  return jsonOf<Answer>(message);
}

export async function agentTurn(ctx: Ctx, st: AgentState, input: string, turn: number) {
  const { kit } = ctx;
  const tools = jsonPrompt<unknown[]>(kit, "tools.json");
  st.messages.push({ role: "user", content: input });
  for (let round = 1; round <= kit.settings.maxToolRounds; round++) {
    // last round: no tools, so the turn always ends with the agent's own words
    const { message, call: meta } = await call(kit, "agent", { system: st.system, messages: st.messages, tools, toolChoiceNone: round === kit.settings.maxToolRounds });
    st.calls.push({ ...meta, turn, round });
    st.messages.push({ role: "assistant", content: message.content });
    if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") throw new Error(`agent stopped: ${message.stop_reason}`);
    const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (uses.length === 0) return;
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      try {
        results.push({ type: "tool_result", tool_use_id: u.id, content: await runTool(ctx, st, u.name, u.input as any, turn) });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: u.id, content: e instanceof Error ? e.message : String(e), is_error: true });
      }
    }
    st.messages.push({ role: "user", content: results });
    if (st.closed) return;
  }
}

function need(input: any, keys: string[]) {
  const missing = keys.filter((k) => typeof input?.[k] !== "string" || !input[k].trim());
  if (missing.length) throw new Error(`INVALID_INPUT: ${missing.join(", ")} is required.`);
}

async function runTool(ctx: Ctx, st: AgentState, name: string, input: any, turn: number): Promise<string> {
  const { replay } = ctx;
  if (name === "send_message") {
    need(input, ["to", "body"]);
    const docs = visibleDocs(ctx);
    const attachments = (Array.isArray(input.attachments) ? input.attachments : []).map((a: unknown) => String(a).replace(/^\/?documents\//, ""));
    const unknown = attachments.filter((a: string) => !docs.includes(a));
    if (unknown.length) throw new Error(`NOT_FOUND: ${unknown.join(", ")} is not in /documents.`);
    const m = push(replay, { turn, author: "agent", kind: "message", channel: input.channel?.trim() || "Email", from: "Agent", to: input.to, subject: input.subject, body: input.body, attachments, follows: [] });
    return `Sent. Saved as /messages/${pad(m.n)}.`;
  }
  if (name === "add_note") {
    need(input, ["body"]);
    const m = push(replay, { turn, author: "agent", kind: "note", channel: "Note", from: "Agent", to: "Case record", body: input.body, attachments: [], follows: [] });
    return `Saved as /messages/${pad(m.n)}.`;
  }
  if (name === "close_case") {
    need(input, ["outcome"]);
    st.closed = { outcome: input.outcome, turn };
    return "Case closed.";
  }
  return fsTool(ctx, name, input);
}
