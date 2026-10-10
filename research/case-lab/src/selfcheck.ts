// npm run check: the smallest checks that fail if the parser or the grounding guard breaks.
import assert from "node:assert/strict";
import { allCases, getCase } from "./cases.ts";
import { visibleDocs, type Ctx, type Msg } from "./casefs.ts";
import { ground } from "./simulator.ts";
import { loadEnv } from "./llm.ts";

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
console.log("selfcheck ok");
