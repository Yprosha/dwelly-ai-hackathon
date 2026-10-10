// Parses the public insurance cases (<CASES_DIR>/<id>/{index.md,history.md,attachments/}) into plain objects, plus
// the hard and complex synthetic eval cases (<EVAL_CASES_DIR>/<id>, ids 101+), whose history ends at the escalation point.
// CASES_DIR follows the repo convention: data/public-cases/Insurance Claims Processing unless set.
import fs from "node:fs";
import path from "node:path";

const casesDir = () => process.env.CASES_DIR ?? path.resolve(import.meta.dirname, "../../../data/public-cases/Insurance Claims Processing");
const evalDir = () => process.env.EVAL_CASES_DIR ?? path.resolve(import.meta.dirname, "../../../eval/cases");

export type Event = { n: number; ts: string; channel: string; from: string; to: string; stage?: string; body: string };
export type Attachment = { name: string; firstEvent: number | null }; // first event whose body mentions the file
export type Case = {
  key: string; // "insurance-032"
  track: string;
  id: string;
  title: string;
  dir: string;
  details: Record<string, string>;
  request: string;
  context: string;
  answer: Record<string, string>; // Overview / Next action / Outcome / Boundaries: never shown to the agent
  events: Event[];
  attachments: Attachment[];
  synthetic?: boolean; // an eval case: no real future to replay; graded against expected_answer.md and rubric.json
  reference: { overview: string; next_action: string; full: string }; // what the reviewer grades the answer against; never shown to the agent
};

const NOT_ANSWER = new Set(["Case details", "Initial request", "Context", "History", "Attachments"]);

function sections(md: string): Record<string, string> {
  const parts = md.split(/^## (.+)$/m);
  const out: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) out[parts[i].trim()] = parts[i + 1].trim();
  return out;
}

function fields(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/^- \*\*(.+?):\*\* ?(.*)$/gm)].map((m) => [m[1], m[2]]));
}

function events(md: string): Event[] {
  return md.split(/<a id="event-\d+"><\/a>/).slice(1).map((chunk) => {
    const [head, ...rest] = chunk.trim().split("\n");
    const lines = rest.join("\n").trim().split("\n");
    let i = 0;
    while (i < lines.length && lines[i].startsWith("- **")) i++;
    const meta = Object.fromEntries(Object.entries(fields(lines.slice(0, i).join("\n"))).map(([k, v]) => [k.toLowerCase(), v]));
    const m = head.match(/^## (\S+ \S+) UTC — event (\d+)/);
    if (!m) throw new Error(`bad event header: ${head}`);
    return { n: Number(m[2]), ts: m[1], channel: meta.channel ?? "", from: meta.from ?? "", to: meta.to ?? "", stage: meta.stage, body: lines.slice(i).join("\n").trim() };
  });
}

function parse(root: string, id: string): Case {
  const track = path.basename(root);
  const dir = path.join(root, id);
  const idx = fs.readFileSync(path.join(dir, "index.md"), "utf8");
  const sec = sections(idx);
  const evs = events(fs.readFileSync(path.join(dir, "history.md"), "utf8"));
  const attDir = path.join(dir, "attachments");
  const names = fs.existsSync(attDir) ? fs.readdirSync(attDir).filter((f) => !f.startsWith(".")).sort() : [];
  return {
    key: `${track.split(" ")[0].toLowerCase()}-${id}`,
    track,
    id,
    title: idx.match(/^# Case \d+: (.+)$/m)?.[1] ?? id,
    dir,
    details: fields(sec["Case details"] ?? ""),
    request: sec["Initial request"] ?? "",
    context: sec["Context"] ?? "",
    answer: Object.fromEntries(Object.entries(sec).filter(([h]) => !NOT_ANSWER.has(h))),
    reference: {
      overview: sec["Overview"] ?? "",
      next_action: sec["Next action at escalation"] ?? "",
      full: `Overview: ${sec["Overview"] ?? "(none)"}\n\nNext action at escalation: ${sec["Next action at escalation"] ?? "(none)"}`,
    },
    events: evs,
    attachments: names.map((name) => ({
      name,
      firstEvent: evs.find((e) => e.body.toLowerCase().includes(name.toLowerCase()))?.n ?? null,
    })),
  };
}

// The names the handler signs with in the real case: the person at the brokerage, not its records or teams
// (the simulator plays those). Found from the Broker field and from "Name, Brokerage" / "Name at Brokerage" parties;
// when the brokerage never appears next to a name, event 1 decides: a bare first name is the handler's own note,
// otherwise the handler is whoever event 1 was addressed to.
export function handlerNames(c: Case): string[] {
  const broker = c.details.Broker ?? "";
  const org = broker.match(/[A-Z][a-z]+ (?:Cover|Risk|Brokers|Insurance)/)?.[0] ?? "";
  const orgWords = new Set(org.split(" "));
  const first = (party: string) => party.split(",")[0].trim().split(/\s+/)[0] ?? "";
  const names = new Set((broker.match(/\b[A-Z][a-z]+\b/g) ?? []).filter((w) => !orgWords.has(w)));
  for (const e of c.events) for (const party of [e.from, e.to]) if (org && party.includes(org) && !orgWords.has(first(party))) names.add(first(party));
  const ours = (from: string) => names.has(first(from));
  if (c.events.length && !c.events.some((e) => ours(e.from))) {
    const e = c.events[0];
    names.add(e.from.split(",")[0].trim().split(/\s+/).length === 1 ? first(e.from) : first(e.to));
  }
  return [...new Set(c.events.filter((e) => ours(e.from)).map((e) => e.from))];
}

const section = (md: string, heading: string) => md.split(/^## /m).find((s) => s.startsWith(heading + "\n"))?.slice(heading.length).trim() ?? "";

// An eval case: same layout as a public case, with the gold answer and rubric beside it (grader-only).
function synthetic(root: string, id: string): Case {
  const c = parse(root, id);
  const read = (f: string) => (fs.existsSync(path.join(c.dir, f)) ? fs.readFileSync(path.join(c.dir, f), "utf8") : "");
  const expected = read("expected_answer.md");
  const rubric = read("rubric.json") ? JSON.parse(read("rubric.json")) : {};
  const list = (xs: unknown) => (Array.isArray(xs) ? xs.map((x) => `- ${typeof x === "string" ? x : JSON.stringify(x)}`).join("\n") : "");
  return {
    ...c, key: `eval-${id}`, track: "Synthetic eval", synthetic: true,
    reference: {
      overview: section(expected, "Situation") || String(rubric.summary ?? ""),
      next_action: section(expected, "Next steps") || list(rubric.required_outcomes),
      full: [expected && `## Expected answer\n\n${expected}`, Object.keys(rubric).length > 0 && `## Grading rubric\n\n${JSON.stringify(rubric, null, 2)}`].filter(Boolean).join("\n\n"),
    },
  };
}

let cache: Case[] | undefined;
export function allCases(): Case[] {
  if (cache) return cache;
  const root = casesDir();
  if (!fs.existsSync(root)) throw new Error(`No cases at ${root}. Put the public Insurance Claims Processing cases there or set CASES_DIR.`);
  const ev = evalDir(); // the hard (1xx) and complex (2xx) synthetic sets; the easy 0xx rehearsal set stays out
  const syn = fs.existsSync(ev) ? fs.readdirSync(ev).filter((id) => /^\d+$/.test(id) && Number(id) >= 101).sort().map((id) => synthetic(ev, id)) : [];
  return (cache = [...fs.readdirSync(root).filter((id) => /^\d+$/.test(id)).sort().map((id) => parse(root, id)), ...syn]);
}

export function getCase(key: string): Case {
  const c = allCases().find((x) => x.key === key);
  if (!c) throw new Error(`unknown case ${key}`);
  return c;
}
