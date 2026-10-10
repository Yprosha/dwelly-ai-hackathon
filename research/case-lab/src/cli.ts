// npm run run -- --split holdout|dev|all [--cases insurance-032,...] [--label baseline]
//                 [--agent opus-5.5] [--simulator opus-5.5] [--judge opus-5.5] [--no-judge] [--concurrency 6] [--seed 0]
//                 [--advisers all|none|creative,risk,web,wordings,precedent]   (names from config/advisers.json)
import { parseArgs } from "node:util";
import { loadEnv, readJson, type Settings } from "./llm.ts";
import { selectKeys, startRun } from "./run.ts";

loadEnv();

const { values: a } = parseArgs({
  options: {
    split: { type: "string" }, cases: { type: "string" }, label: { type: "string" },
    agent: { type: "string" }, simulator: { type: "string" }, judge: { type: "string" },
    "no-judge": { type: "boolean" }, concurrency: { type: "string" }, seed: { type: "string" }, advisers: { type: "string" },
  },
});
const overrides: Partial<Settings> = {};
if (a.agent) overrides.agent = a.agent;
if (a.simulator) overrides.simulator = a.simulator;
if (a.judge) overrides.judge = a.judge;
if (a["no-judge"]) overrides.runJudge = false;
if (a.concurrency) overrides.concurrency = Number(a.concurrency);
if (a.seed) overrides.seedEvents = Number(a.seed);
if (a.advisers) overrides.advisers = a.advisers === "none" ? [] : a.advisers === "all" ? Object.keys(readJson("config/advisers.json")) : a.advisers.split(",").map((s) => s.trim()).filter(Boolean);

const keys = selectKeys({ split: a.split, keys: a.cases?.split(",") });
const { id, done } = startRun({ label: a.label, keys, overrides }, (key, s) =>
  console.log(`${key.padEnd(16)} ${s.status.padEnd(6)} ${(s.stop ?? "").padEnd(10)} escalation=${s.correct === undefined ? s.firstAction ?? "-" : s.correct ? "correct" : "incorrect"} e2e=${s.e2e === undefined ? "-" : s.e2e ? "correct" : "incorrect"} acts=${s.acts ? s.acts.join("/") : "-"} violations=${s.violations ?? "-"} $${(s.cost ?? 0).toFixed(3)}${s.error ? "  " + s.error : ""}`));
console.log(`run ${id}: ${keys.length} cases`);
const meta = await done;
const cs = Object.values(meta.cases);
const judged = cs.filter((c) => c.firstAction);
const acts = judged.reduce((t, c) => [t[0] + c.acts![0], t[1] + c.acts![1]], [0, 0]);
console.log(`done: ${cs.filter((c) => c.status === "done").length}/${cs.length} ok · correct escalations ${cs.filter((c) => (c.correct ?? c.firstAction === "match")).length}/${cs.filter((c) => c.correct !== undefined || c.firstAction).length} · solved end to end ${judged.filter((c) => c.e2e).length}/${judged.length} · acts covered ${acts[0]}/${acts[1]} · violations ${judged.reduce((t, c) => t + (c.violations ?? 0), 0)} · $${cs.reduce((t, c) => t + (c.cost ?? 0), 0).toFixed(2)}`);
