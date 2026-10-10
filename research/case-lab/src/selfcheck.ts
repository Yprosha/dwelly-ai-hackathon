// npm run check: the smallest checks that fail if the parser or the grounding guard breaks.
import assert from "node:assert/strict";
import { allCases, getCase, handlerNames } from "./cases.ts";
import { agentBrief, visibleDocs, type Ctx, type Msg } from "./casefs.ts";
import { ground, seed } from "./simulator.ts";
import { loadEnv, loadKit, promptOf } from "./llm.ts";
import { otherClaims, readClaim, searchClaims } from "./subagent.ts";

loadEnv();

const cases = allCases().filter((k) => !k.synthetic); // the public claims
assert.equal(cases.length, 50);
assert.ok(cases.every((c) => c.key.startsWith("insurance-")));
// the synthetic eval sets: hard 101-113 and complex 201-209, each graded against a rubric (and a gold answer from 201)
const syn = allCases().filter((k) => k.synthetic);
assert.equal(syn.length, 22);
assert.ok(syn.every((k) => k.key.startsWith("eval-") && k.reference.next_action && k.reference.full.includes("## Grading rubric")));
assert.ok(getCase("eval-201").reference.full.includes("## Expected answer"));
const c = getCase("insurance-032");
assert.equal(c.events[5].to, "Wrenfield Property Insurance");
assert.ok(c.answer["Next action at escalation"]);
assert.equal(getCase("insurance-037").attachments[0].firstEvent, 1);

const g = ground("Total is £2,840.00. The fee is £999. Thanks, Rose.", ["Estimated total: £2,840.00"]);
assert.equal(g.body, "Total is £2,840.00. Thanks, Rose.");
assert.deepEqual(g.stripped, ["The fee is £999."]);
assert.equal(ground("Seen on 12 June.\nCall me.", ["no dates"]).body, "Call me.");
// a document the handler sends at real event N shows up once the world has delivered every outside event before N
const world = (n: number): Msg => ({ n, turn: 1, author: "world", kind: "message", channel: "Email", from: "x", to: "y", body: "", attachments: [], follows: [n] });
const docsAfter = (follows: number[]) => visibleDocs({ kit: {} as Ctx["kit"], c: getCase("insurance-007"), replay: follows.map(world), handler: ["Max, Fieldstone Cover"], extract: [] });
assert.deepEqual(docsAfter([1]), []);
assert.deepEqual(docsAfter([1, 3]), ["policy-copy.pdf"]);
// the handler is the person, not the brokerage's records or teams; name variants of the same person all count
assert.deepEqual(handlerNames(getCase("insurance-007")), ["Max, Fieldstone Cover"]);
assert.deepEqual(handlerNames(getCase("insurance-022")), ["Jen Vale"]);
assert.deepEqual(handlerNames(getCase("insurance-037")).sort(), ["Toby Reed", "Toby Reed, Holloway Cover"]);
// every case has an escalation point inside its history, and the first hidden event is the handler's own move
const points = loadKit().escalation;
for (const k of cases) {
  const after = points[k.key]?.after;
  assert.ok(after >= 1 && after < k.events.length, `${k.key}: escalation point ${after} is outside events 1..${k.events.length - 1}`);
  assert.ok(handlerNames(k).includes(k.events[after].from), `${k.key}: event ${after + 1} is not the handler's`);
}
// seeding hands over exactly the events up to the point, the handler's own among them marked as such
const s9 = getCase("insurance-039"), replay9: Msg[] = [];
seed({ kit: {} as Ctx["kit"], c: s9, replay: replay9, handler: handlerNames(s9), extract: [] }, 3);
assert.deepEqual(replay9.map((m) => [m.follows[0], m.author, m.turn]), [[1, "world", 0], [2, "world", 0], [3, "handler", 0]]);
// by default the agent learns who it is and nothing else from the case card: no title, no insurer, no request summary
const kit9 = loadKit({ caseCard: "none" });
assert.equal(agentBrief(kit9, getCase("insurance-009")), "You are handling this case as Josh, Heathmere Brokers.");
assert.ok(cases.every((k) => { const b = agentBrief(kit9, k); return !b.includes(k.title) && !b.includes(k.details.Insurer) && !b.includes(k.request.slice(0, 40)); }));
assert.ok(agentBrief(loadKit({ caseCard: "record" }), getCase("insurance-009")).includes("- Insurer: Alderfen Mutual"));
// sub-agents: their prompts exist and the user prompt's variables are the ones runSubagent fills; the claims search
// finds the obvious precedent and never the case being worked on (the caller hands it every claim but that one)
const kitA = loadKit();
for (const f of ["subagent.system.md", "subagent.tools.json"]) promptOf(kitA, f);
assert.deepEqual([...promptOf(kitA, "subagent.user.md").matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort(), ["case_file", "claims", "documents", "instruction", "messages"]);
assert.ok(JSON.parse(promptOf(kitA, "tools.json")).some((t: { name: string }) => t.name === "run_subagent"));
const others = cases.filter((k) => k.key !== "insurance-017");
assert.match(searchClaims(cases, "unoccupied between tenancies"), /^\[insurance-017 · /);
assert.ok(!searchClaims(others, "unoccupied between tenancies").includes("insurance-017"));
assert.match(searchClaims(others, "zzzqqq"), /^No claim found/);
assert.ok(readClaim(kitA, others, "016").includes("## Outcome") && readClaim(kitA, others, "insurance-016").includes("--- event 1 "));
assert.throws(() => readClaim(kitA, others, "insurance-017"), /NOT_FOUND/);
// the simulator and the judge are both handed the documents' text
const prompts = loadKit().prompts;
assert.ok(prompts["simulator.user.md"].includes("{{documents}}") && prompts["judge.user.md"].includes("{{documents}}"));
// a sub-agent reads every other claim but never the one being worked on: 209 continues 201 on the same property
const others201 = otherClaims(getCase("eval-201")).map((k) => k.key);
assert.ok(!others201.includes("eval-201") && !others201.includes("eval-209") && others201.includes("insurance-032"));
console.log("selfcheck ok");
