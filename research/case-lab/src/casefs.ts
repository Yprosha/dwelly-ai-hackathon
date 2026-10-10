// The case as the agent sees it: a read-only virtual file system rebuilt from the replay on every tool call.
//   /case            the customer request and who the agent is (settings.caseCard controls additional context)
//   /messages/NNN    everything received and sent so far, numbered in order
//   /documents/NAME  attachments delivered so far, as extracted text
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { handlerNames, type Case, type Event } from "./cases.ts";
import { ROOT, call, promptOf, render, textOf, type Call, type Kit } from "./llm.ts";

export type Msg = {
  n: number;
  turn: number;
  author: "agent" | "world" | "handler"; // handler: the real handler's own message, handed over as history
  kind: "message" | "note";
  channel: string;
  from: string;
  to: string;
  subject?: string;
  body: string;
  attachments: string[];
  ts?: string; // real timestamp, only on events delivered verbatim
  follows: number[]; // real events this message follows (world) or corresponds to (agent, as judged by the simulator)
  match?: string; // simulator's label for world messages
  stripped?: string[]; // sentences removed by the grounding check
  verdict?: string; reason?: string; quotes?: string[]; // agent messages: the simulator's on_track / over_request / extra_message call
};

// Everything one case run shares: settings and prompts, the case, the replay so far, who the handler is.
export type Ctx = { kit: Kit; c: Case; replay: Msg[]; handler: string[]; extract: Call[] };

export const pad = (n: number) => String(n).padStart(3, "0");

export function push(replay: Msg[], m: Omit<Msg, "n">): Msg {
  const msg = { ...m, n: replay.length + 1 };
  replay.push(msg);
  return msg;
}

export function caseFile(kit: Kit, c: Case): string {
  const hidden = new Set(kit.settings.hiddenDetails);
  const details = Object.entries(c.details).filter(([k]) => !hidden.has(k)).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  return [`# ${c.title}`, details, `## Initial request\n\n${c.request}`, c.context && `## Context\n\n${c.context}`].filter(Boolean).join("\n\n");
}

// The initial request is task input in every mode. Keep the retrospective title, context and outcome out of
// none/record briefs; record adds the broker, insurer and property. Graders get the full card (caseFile).
export function agentBrief(kit: Kit, c: Case): string {
  const mode = kit.settings.caseCard ?? "full"; // kits saved before this setting showed the whole card
  if (mode === "full") return caseFile(kit, c);
  const me = [...handlerNames(c)].sort((a, b) => b.length - a.length)[0] ?? c.details.Broker ?? "the broker";
  // a handed case may bring sections of its own (a question, an instruction): they are task input too
  const who = [`You are handling this case as ${me}.\n\n## Initial request\n\n${c.request || "(not provided)"}`, c.handed?.extra].filter(Boolean).join("\n\n");
  if (mode !== "record") return who;
  const record = ["Broker", "Insurer", "Property"].filter((k) => c.details[k]).map((k) => `- ${k}: ${c.details[k]}`).join("\n");
  return record ? `${who}\n\nOn record:\n${record}` : who;
}

export const eventAttachments = (c: Case, e: Event) => c.attachments.filter((a) => a.firstEvent === e.n).map((a) => a.name);

export function renderMsg(m: Msg): string {
  return [
    `/messages/${pad(m.n)}`,
    m.ts && `date: ${m.ts} UTC`,
    `channel: ${m.channel}`,
    `from: ${m.from}`,
    `to: ${m.to}`,
    m.subject && `subject: ${m.subject}`,
    m.attachments.length > 0 && `attachments: ${m.attachments.map((a) => `/documents/${a}`).join(", ")}`,
    "---",
    m.body,
  ].filter(Boolean).join("\n");
}

// Attachments the agent holds: never mentioned in the history, delivered with a message, or first sent out by the
// handler's own side at real event N once the world has delivered every outside event before N (it had them by then).
export function visibleDocs({ c, replay, handler }: Ctx): string[] {
  if (c.handed) return c.attachments.map((a) => a.name); // the whole history is handed over, and so is every file
  const delivered = new Set(replay.flatMap((m) => m.attachments));
  const progress = Math.max(0, ...replay.filter((m) => m.author !== "agent").flatMap((m) => m.follows));
  const ours = (n: number) => handler.includes(c.events.find((e) => e.n === n)?.from ?? "");
  const due = (n: number) => c.events.every((e) => e.n >= n || handler.includes(e.from) || e.n <= progress);
  return c.attachments.filter((a) => a.firstEvent === null || delivered.has(a.name) || (ours(a.firstEvent) && due(a.firstEvent))).map((a) => a.name);
}

const IMAGE: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const TEXT = new Set([".txt", ".csv", ".md", ".json"]);

// Text of an attachment. PDFs and images go through Claude once (prompts/extract.*), then live in cache/extracted/.
// Reads of the same file at the same time (parallel tool calls, sub-agents) share one extraction.
const extracting = new Map<string, Promise<string>>();
export function extract(ctx: Ctx, name: string): Promise<string> {
  const cached = path.join(ROOT, "cache/extracted", ctx.c.key, `${name}.md`);
  if (!extracting.has(cached)) extracting.set(cached, extractOnce(ctx, name, cached).finally(() => extracting.delete(cached)));
  return extracting.get(cached)!;
}

async function extractOnce({ kit, c, extract: calls }: Ctx, name: string, cached: string): Promise<string> {
  if (fs.existsSync(cached)) return fs.readFileSync(cached, "utf8");
  const file = c.attachments.find((a) => a.name === name)?.file ?? path.join(c.dir, "attachments", name);
  const ext = path.extname(name).toLowerCase();
  let text: string;
  if (TEXT.has(ext)) text = fs.readFileSync(file, "utf8");
  else if (c.handed && !(ext === ".pdf" || IMAGE[ext])) { // a handed case can bring any format: read whatever is text
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) return `(no text can be extracted from ${name})`;
    text = buf.toString("utf8");
  } else if (ext === ".pdf" || IMAGE[ext]) {
    const data = fs.readFileSync(file).toString("base64");
    const block: Anthropic.Beta.BetaContentBlockParam = ext === ".pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: IMAGE[ext] as "image/png", data } };
    const r = await call(kit, "extractor", {
      system: promptOf(kit, "extract.system.md"),
      messages: [{ role: "user", content: [block, { type: "text", text: render(promptOf(kit, "extract.user.md"), { filename: name }) }] }],
    });
    calls.push(r.call);
    text = textOf(r.message);
  } else return `(no text can be extracted from ${name})`;
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, text);
  return text;
}

// A document's text for the judge's or the simulator's prompt (the agent reads documents through read_case).
const MAX_DOC = 12_000;
export async function docText(ctx: Ctx, name: string): Promise<string> {
  const text = await extract(ctx, name);
  return text.length > MAX_DOC ? text.slice(0, MAX_DOC) + "\n... [truncated]" : text;
}

const MAX_READ = 30_000; // ponytail: no read windows or #L anchors; add them if documents get long

export async function fsTool(ctx: Ctx, name: string, input: any): Promise<string> {
  const { kit, c, replay } = ctx;
  const docs = visibleDocs(ctx);
  const norm = (p: unknown) => "/" + String(p ?? "/").trim().replace(/^\/+|\/+$/g, "");
  const read = async (p: string): Promise<string> => {
    if (p === "/case") return agentBrief(kit, c);
    const m = p.match(/^\/messages\/(\d+)$/);
    const msg = m && replay.find((x) => x.n === Number(m[1]));
    if (msg) return renderMsg(msg);
    const d = p.match(/^\/documents\/(.+)$/);
    if (d && docs.includes(d[1])) return extract(ctx, d[1]);
    throw new Error(`NOT_FOUND: ${p}. Use list_case to see what exists.`);
  };
  const all = () => ["/case", ...replay.map((x) => `/messages/${pad(x.n)}`), ...docs.map((x) => `/documents/${x}`)];

  if (name === "list_case") {
    const p = norm(input?.path);
    if (p === "/") return "/case\n/messages/\n/documents/";
    if (p === "/messages") return replay.map((x) => `/messages/${pad(x.n)}  ${x.channel} · ${x.from} → ${x.to}`).join("\n") || "(empty)";
    if (p === "/documents") return docs.map((x) => `/documents/${x}`).join("\n") || "No documents are available here. Other brokerage records may exist; ask the relevant internal team through send_message if needed.";
    throw new Error(`NOT_FOUND: ${p} is not a directory. Directories: /, /messages, /documents.`);
  }
  if (name === "read_case") {
    const text = await read(norm(input?.path));
    return text.length > MAX_READ ? text.slice(0, MAX_READ) + "\n... [truncated]" : text;
  }
  if (name === "search_case") {
    let re: RegExp;
    try { re = new RegExp(String(input?.pattern ?? ""), "i"); } catch { throw new Error("INVALID_PATTERN: not a valid regular expression."); }
    const scope = norm(input?.path);
    const hits: string[] = [];
    for (const p of all().filter((x) => scope === "/" || x === scope || x.startsWith(scope + "/")))
      (await read(p)).split("\n").forEach((line, i) => { if (re.test(line)) hits.push(`${p}#L${i + 1}: ${line.slice(0, 300)}`); });
    return hits.length > 50 ? hits.slice(0, 50).join("\n") + `\n... ${hits.length - 50} more matches` : hits.join("\n") || "No matches.";
  }
  throw new Error(`Unknown tool: ${name}`);
}
