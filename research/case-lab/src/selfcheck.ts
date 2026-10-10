// npm run check: the smallest checks that fail if the parser or the grounding guard breaks.
import assert from "node:assert/strict";
import { allCases, getCase, handlerNames } from "./cases.ts";
import { agentBrief, visibleDocs, type Ctx, type Msg } from "./casefs.ts";
import { ground, seed } from "./simulator.ts";
import { loadEnv, loadKit, promptOf } from "./llm.ts";
import { checkAdvisers, readClaim, searchClaims } from "./council.ts";

loadEnv();

const cases = allCases();
assert.equal(cases.length, 50);
assert.ok(cases.every((c) => c.key.startsWith("insurance-")));
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
// the council: every configured adviser has a preset and a prompt; the claims search finds the obvious precedent and
// never the case being worked on (the caller hands it every claim but that one)
const kitA = loadKit({ advisers: Object.keys(loadKit().advisers) });
assert.equal(kitA.settings.advisers!.length, 5);
checkAdvisers(kitA);
assert.throws(() => checkAdvisers(loadKit({ advisers: ["nobody"] })), /unknown adviser/);
for (const f of ["adviser.system.md", "adviser.user.md", "adviser.claims.md", "agent.advice.md", "adviser.tools.json"]) promptOf(kitA, f);
const others = cases.filter((k) => k.key !== "insurance-017");
assert.match(searchClaims(kitA, cases, "unoccupied between tenancies"), /^\[insurance-017 · /);
assert.ok(!searchClaims(kitA, others, "unoccupied between tenancies").includes("insurance-017"));
assert.match(searchClaims(kitA, others, "zzzqqq"), /^No claim found/);
assert.ok(readClaim(kitA, others, "016").includes("## Outcome") && readClaim(kitA, others, "insurance-016").includes("--- event 1 "));
assert.throws(() => readClaim(kitA, others, "insurance-017"), /NOT_FOUND/);
// the simulator and the judge are both handed the documents' text
const prompts = loadKit().prompts;
assert.ok(prompts["simulator.user.md"].includes("{{documents}}") && prompts["judge.user.md"].includes("{{documents}}"));
console.log("selfcheck ok");
