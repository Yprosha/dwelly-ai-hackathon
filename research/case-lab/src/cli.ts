// npm run run -- --split holdout|dev|all [--cases insurance-032,...] [--label baseline]
//                 [--agent opus-5.5] [--simulator opus-5.5] [--judge opus-5.5] [--no-judge] [--concurrency 6] [--seed 0]
//                 [--no-subagents] [--panel all|researcher,conservative,...]
// npm run run -- --dir <folder of cases> [--out ../../ANSWERS] [--logs ../../logs] [--timeout 15]   a real run: each case gets
//                 <out>/<case>/ANSWER.md and REASONING.md, and its trace in <logs>/<case>.json
import path from "node:path";
import { parseArgs } from "node:util";
import { loadDir } from "./cases.ts";
import { ROOT, loadEnv, readJson, type Settings } from "./llm.ts";
import { selectKeys, startRun } from "./run.ts";

loadEnv();

const { values: a } = parseArgs({
  options: {
    split: { type: "string" }, cases: { type: "string" }, label: { type: "string" },
    agent: { type: "string" }, simulator: { type: "string" }, judge: { type: "string" },
    "no-judge": { type: "boolean" }, concurrency: { type: "string" }, seed: { type: "string" }, "no-subagents": { type: "boolean" }, panel: { type: "string" },
    dir: { type: "string" }, out: { type: "string" }, logs: { type: "string" }, timeout: { type: "string" },
  },
});
const overrides: Partial<Settings> = {};
if (a.agent) overrides.agent = a.agent;
if (a.simulator) overrides.simulator = a.simulator;
if (a.judge) overrides.judge = a.judge;
if (a["no-judge"]) overrides.runJudge = false;
if (a.concurrency) overrides.concurrency = Number(a.concurrency);
if (a.seed) overrides.seedEvents = Number(a.seed);
if (a["no-subagents"]) overrides.subagents = false;
if (a.panel) overrides.panel = a.panel === "all" ? Object.keys(readJson("config/panel.json")) : a.panel.split(",");

// A handed folder has no answer key: nothing to judge or review against.
const only = a.cases?.split(",");
const handed = a.dir ? loadDir(a.dir).filter((c) => !only || only.includes(c.handed!.name) || only.includes(c.key)) : undefined;
const out = handed && { answers: path.resolve(a.out ?? path.join(ROOT, "../../ANSWERS")), logs: path.resolve(a.logs ?? path.join(ROOT, "../../logs")) };
if (handed) Object.assign(overrides, { runJudge: false, runReviewer: false });
const keys = handed ? handed.map((c) => c.key) : selectKeys({ split: a.split, keys: only });
const { id, done } = startRun({ label: a.label ?? (handed ? "reality-test" : undefined), keys, overrides, out, timeoutMin: Number(a.timeout ?? 15), dir: a.dir && path.resolve(a.dir) }, (key, s) =>
  console.log(`${key.padEnd(16)} ${s.status.padEnd(6)} ${(s.stop ?? "").padEnd(10)} escalation=${s.correct === undefined ? s.firstAction ?? "-" : s.correct ? "correct" : "incorrect"} e2e=${s.e2e === undefined ? "-" : s.e2e ? "correct" : "incorrect"} acts=${s.acts ? s.acts.join("/") : "-"} violations=${s.violations ?? "-"} $${(s.cost ?? 0).toFixed(3)}${s.error ? "  " + s.error : ""}`));
console.log(`run ${id}: ${keys.length} cases`);
const meta = await done;
const cs = Object.values(meta.cases);
if (out) {
  const failed = Object.entries(meta.cases).filter(([, c]) => c.status !== "done").map(([k]) => k);
  console.log(`answers: ${out.answers}  traces: ${out.logs}\n${cs.length - failed.length}/${cs.length} cases answered${failed.length ? ` · no answer for ${failed.join(", ")} (each still has ANSWER.md saying so)` : ""} · $${cs.reduce((t, c) => t + (c.cost ?? 0), 0).toFixed(2)}`);
  process.exit(0);
}
const pub = Object.entries(meta.cases).filter(([k]) => !k.startsWith("eval-")).map(([, c]) => c);
const syn = Object.entries(meta.cases).filter(([k, c]) => k.startsWith("eval-") && c.correct !== undefined).map(([, c]) => c);
const judged = cs.filter((c) => c.firstAction);
const acts = judged.reduce((t, c) => [t[0] + c.acts![0], t[1] + c.acts![1]], [0, 0]);
console.log(`done: ${cs.filter((c) => c.status === "done").length}/${cs.length} ok · correct escalations ${pub.filter((c) => (c.correct ?? c.firstAction === "match")).length}/${pub.filter((c) => c.correct !== undefined || c.firstAction).length}${syn.length ? ` · synthetic correct ${syn.filter((c) => c.correct).length}/${syn.length}` : ""} · solved end to end ${judged.filter((c) => c.e2e).length}/${judged.length} · acts covered ${acts[0]}/${acts[1]} · violations ${judged.reduce((t, c) => t + (c.violations ?? 0), 0)} · $${cs.reduce((t, c) => t + (c.cost ?? 0), 0).toFixed(2)}`);
