// Parses the public insurance cases (<CASES_DIR>/<id>/{index.md,history.md,attachments/}) into plain objects, plus
// synthetic eval cases (<EVAL_CASES_DIR>/<id>), whose history ends at the escalation point.
// CASES_DIR follows the repo convention: data/public-cases/Insurance Claims Processing unless set.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const casesDir = () => process.env.CASES_DIR ?? path.resolve(import.meta.dirname, "../../../data/public-cases/Insurance Claims Processing");
const evalDir = () => process.env.EVAL_CASES_DIR ?? path.resolve(import.meta.dirname, "../../../eval/cases");

export type Event = { n: number; ts: string; channel: string; from: string; to: string; subject?: string; stage?: string; body: string };
export type Attachment = { name: string; firstEvent: number | null; file?: string }; // first event whose body mentions the file; file: where it is, when not in <dir>/attachments
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
  handed?: { name: string; extra: string; notes: string[] }; // a case from a folder given to loadDir: its folder name, index.md sections the agent is also shown, what could not be parsed
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
    return { n: Number(m[2]), ts: m[1], channel: meta.channel ?? "", from: meta.from ?? "", to: meta.to ?? "", subject: meta.subject, stage: meta.stage, body: lines.slice(i).join("\n").trim() };
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

// A folder of cases handed over for a real run (the Reality Test). There is no answer key and no future to replay:
// the history ends where the agent takes over, so each case runs like a synthetic one, without a reviewer.
// The layout is whatever arrives. A case is any folder holding index.md or history.md, however deep; if there is
// none, every entry of the folder is a case. Every other file of a case becomes a document, and a history that is
// not in the events format is handed over as a document too.
const ANSWER = new Set(["Overview", "Next action at escalation", "Outcome"]); // hidden if a handed case still has them
const GRADER = new Set(["expected_answer.md", "rubric.json"]);

function walk(dir: string, rel = ""): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? walk(dir, path.join(rel, e.name)) : [path.join(rel, e.name)]));
}

function findCases(dir: string, depth = 0): string[] {
  const names = fs.readdirSync(dir).filter((f) => !f.startsWith("."));
  if (names.includes("index.md") || names.includes("history.md")) return [dir];
  if (depth >= 3) return [];
  return names.map((n) => path.join(dir, n)).filter((p) => fs.statSync(p).isDirectory()).flatMap((p) => findCases(p, depth + 1));
}

function handedCase(p: string, tag: string): Case {
  const isDir = fs.statSync(p).isDirectory();
  const root = isDir ? p : path.dirname(p);
  const files = isDir ? walk(p) : [path.basename(p)];
  const name = isDir ? path.basename(p) : path.parse(p).name;
  const notes: string[] = [];
  const idx = files.includes("index.md") ? fs.readFileSync(path.join(root, "index.md"), "utf8") : "";
  const sec = sections(idx);
  let evs: Event[] = [];
  if (files.includes("history.md")) {
    try { evs = events(fs.readFileSync(path.join(root, "history.md"), "utf8")); } catch (e) { notes.push(`history.md could not be parsed as events (${e instanceof Error ? e.message.slice(0, 120) : e}); it was handed over as a document`); }
    if (!evs.length && !notes.length) notes.push("history.md holds no events in the expected format; it was handed over as a document");
  } else notes.push("no history.md; the files were handed over as documents");
  const docs = files.filter((f) => f !== "index.md" && !GRADER.has(f) && !(f === "history.md" && evs.length > 0));
  if (!evs.length) evs = [{ n: 1, ts: "", channel: "Case file", from: "Case file", to: "Handler", body: "This case arrived as files, not as a message history. Everything known about it is in /documents: read all of them before acting." }];
  return {
    key: `handed-${tag}-${name.replace(/[^A-Za-z0-9_.-]+/g, "-")}`,
    track: "Handed over", id: name, title: idx.match(/^# (?:Case \S+: )?(.+)$/m)?.[1] ?? name, dir: root,
    details: fields(sec["Case details"] ?? ""),
    request: sec["Initial request"] ?? "",
    context: sec["Context"] ?? "",
    answer: {}, reference: { overview: "", next_action: "", full: "" },
    events: evs,
    attachments: docs.map((f) => {
      const n = f.startsWith(`attachments${path.sep}`) ? f.slice(12) : f;
      return { name: n, file: path.join(root, f), firstEvent: evs.find((e) => e.body.toLowerCase().includes(path.basename(n).toLowerCase()))?.n ?? null };
    }),
    synthetic: true,
    handed: { name, notes, extra: Object.entries(sec).filter(([h]) => !NOT_ANSWER.has(h) && !ANSWER.has(h)).map(([h, b]) => `## ${h}\n\n${b}`).join("\n\n") },
  };
}

let handed: Case[] = [];
export function loadDir(dir: string): Case[] {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) throw new Error(`No such folder: ${root}`);
  let found = fs.statSync(root).isDirectory() ? findCases(root) : [root];
  if (!found.length) found = fs.readdirSync(root).filter((f) => !f.startsWith(".") && !/^(readme|license)/i.test(f)).map((f) => path.join(root, f));
  // a folder beside the cases found is a case too, even without index.md or history.md
  if (!found.includes(root)) for (const parent of new Set(found.map((p) => path.dirname(p)))) for (const n of fs.readdirSync(parent)) {
    const p = path.join(parent, n);
    if (!n.startsWith(".") && fs.statSync(p).isDirectory() && !found.includes(p) && walk(p).length) found.push(p);
  }
  found.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
  const tag = createHash("sha1").update(root).digest("hex").slice(0, 6); // keeps the extraction cache of one folder apart from another's
  handed = found.map((p) => handedCase(p, tag));
  const names = handed.map((c) => c.handed!.name);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length) throw new Error(`Two cases are called ${[...new Set(twice)].join(", ")} under ${root}: their answers would overwrite each other. Point --dir at one set of cases.`);
  if (!handed.length) throw new Error(`No cases found in ${root}`);
  return handed;
}

let cache: Case[] | undefined;
export function allCases(): Case[] {
  if (cache) return cache;
  const root = casesDir();
  if (!fs.existsSync(root)) throw new Error(`No cases at ${root}. Put the public Insurance Claims Processing cases there or set CASES_DIR.`);
  const ev = evalDir(); // all rehearsal cases: 0xx, hard 1xx and complex 2xx
  const syn = fs.existsSync(ev) ? fs.readdirSync(ev).filter((id) => /^\d+$/.test(id)).sort().map((id) => synthetic(ev, id)) : [];
  return (cache = [...fs.readdirSync(root).filter((id) => /^\d+$/.test(id)).sort().map((id) => parse(root, id)), ...syn]);
}

export function getCase(key: string): Case {
  const c = handed.find((x) => x.key === key) ?? allCases().find((x) => x.key === key);
  if (!c) throw new Error(`unknown case ${key}`);
  return c;
}
