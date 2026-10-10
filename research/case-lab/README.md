# Case Lab

An agent that works the **Insurance Claims Processing** cases end to end against simulated counterparties, plus a UI to read what happened. It has a copilot loop, claim-as-file-system tools, a replay-engine counterparty and a comms-checklist judge.

```bash
cd research/case-lab
npm install
npm start
```

Then open http://localhost:5177.

- **API key:** read from the repo's root `.env` or `research/case-lab/.env` as `ANTHROPIC_API_KEY`. Both are gitignored.
- **Cases:** read from `data/public-cases/Insurance Claims Processing`, the same place `research/insurance-sim` uses. Set `CASES_DIR` to read them from somewhere else.
- **Baseline:** `runs/` ships with the holdout baseline, so the UI has something to show straight away. New runs stay local. That baseline was made before escalation starts and began at the opening; the UI says where each run started.

The UI has two modes:

- **Simple** is for reviewing. It has a scorecard, the claim list, an "Agent vs the real claim" fold, an Emails mailbox (this run or the real claim) and the agent's Chat. The claims list and the Emails column can be dragged by their edge or hidden with the chevron on it (double-click the edge to reset), to give the chat more room.
- **Full** is for building. It has the agent trace with thinking and tokens, simulator turns, judge details, a side-by-side replay, run config, New run, and Prompts & settings.

**Demo run** (the link beside a claim's title in Simple, or `#/demo/<run>/<case>`) plays a finished claim back as if the agent were working on it now, for showing how it works. The page opens as it stood before the agent started; **Run** then fills the chat event by event and lands each email in the mailbox when it was sent or received. It calls no model: the pace is the recorded one (model calls, sub-agents and replies take as long as they took), and `#/demo/<run>/<case>/2` plays it twice as fast. The verdicts stay hidden until the run is over.

To run from the terminal instead (runs show up in the UI either way):

```bash
npm run run -- --split holdout --label baseline
```

```bash
npm run run -- --cases insurance-032,insurance-037 --agent sonnet-5.5 --no-judge
```

## A real run: a folder of cases in, `ANSWERS/` out

For cases nobody has seen (the Reality Test), give the folder they arrived in:

```bash
npm run run -- --dir "<path to the folder of cases>"
```

Each case gets `ANSWERS/<case folder name>/ANSWER.md` and `REASONING.md` at the repo root, its full trace in `logs/<case folder name>.json`, and the run's settings, model presets and prompts in `logs/run.json`. `--out` and `--logs` change where they go; `--cases 3,7` runs only those folders; `--panel`, `--no-subagents`, `--agent` and `--concurrency` work as in any other run.

- **What counts as a case.** Any folder holding `index.md` or `history.md`, however deep under the folder you give, and every folder beside one. If there is none, each entry of the folder is a case. Two cases with the same folder name stop the run before it starts, because their answers would overwrite each other.
- **What the agent gets.** The whole history, since it ends where the agent takes over, and every other file of the case as a document: PDFs and images are transcribed, anything else that is text is read as it is. From `index.md` it gets what `caseCard` allows, plus any section that is not part of the public layout (a question, an instruction). `Overview`, `Next action at escalation` and `Outcome` stay hidden if a case still has them. A history that is not in the events format is handed over as a document and `REASONING.md` says so.
- **What runs.** The agent's first turn and its answer. There is no simulated counterparty, judge or reviewer: there is no answer key to hold them to.
- **`ANSWER.md`**: the agent's Overview and Next action at escalation, then every message, note and closure it issued, word for word. **`REASONING.md`**: what the system received, each step it took (reads, searches, sub-agents, model thinking summaries), the panel's and sub-agents' reports, what failed, models, cost and time.
- **A case still running after 15 minutes** (`--timeout`, in minutes, counted from when the case started) gets both files saying it was not finished, so a run always ends with every case accounted for.
- **A case that fails** is tried once more. If it fails again, it still gets both files: `ANSWER.md` says the system wrote no answer and the case needs a human, and `REASONING.md` gives the error. Nothing is filled in by hand.

The run shows up in the UI like any other, as long as the folder is still where it was.

## Cases

- **Public claims** (50): the Insurance Claims Processing cases, with a real history after the escalation point that the simulator replays.
- **Synthetic eval cases** (44: `eval-001`…`eval-022` rehearsal, `eval-101`…`eval-113` hard, `eval-201`…`eval-209` complex): read from `eval/cases` (`EVAL_CASES_DIR`). Their history ends at the escalation point, so the agent gets all of it, writes its answer and stops; there is no simulated future and no judge. The reviewer grades the answer against the case's `expected_answer.md` (complex set) and `rubric.json`. Neither file is ever shown to the agent.
- Splits in `config/splits.json`: `holdout`, `dev`, `synthetic`; `--split all` runs everything.

## How a case runs

1. **Handover at the escalation point.** Every public case has a "Next action at escalation" note that refers to one moment in its history. The agent starts there: it is handed, word for word, every real event up to that point, the real handler's own earlier messages among them, and nothing that came after. The points live in `config/escalation.json` (`after` = the last real event the agent sees), taken from `eval/public_escalation_points.json`.
   - Set `startAt` to `opening` to start from the beginning instead: the simulator then delivers every real event before the broker first writes to anyone.
   - Set `seedEvents` to N to hand over the first N real events, whatever `startAt` says.
2. **Agent turn.** The agent reads the case through `list_case`, `read_case` and `search_case`, then acts with `send_message`, `add_note` or `close_case`. Ending its turn without a tool call means "wait for replies".
   - The case is exposed as files: `/case`, `/messages/NNN`, and `/documents/NAME` (attachments as text).
   - `/case` always includes the **Initial request**, its stated requester role and the agent's identity. An explicitly named broker takes precedence over colleagues and other participants. `caseCard` in settings adds broker, insurer and property (`record`) or the whole card (`full`). The retrospective title, context and answer sections stay out of `none`/`record` briefs. Message subjects are preserved. Missing local attachments do not establish that the brokerage has no records; necessary internal checks can run alongside independent customer or insurer actions. Deferring an action requires explaining which dependency actually prevents safe, accurate action.
   - PDFs and images are transcribed by Claude on first read and cached in `cache/extracted/`.
   - **The answer.** Right after its first turn, still at the escalation point and before any reply, the agent writes its answer the way the case file records it: **Overview** and **Next action at escalation** (`prompts/agent.answer.md`). Each answer is saved as `runs/<id>/answers/<key>.md`.
3. **World turn.** The simulator plays everyone except the handler. It follows the real history, adapts it to what the agent actually wrote, and stays silent when the real parties had nothing left to say.
   - The simulator reads the text of the real attachments, so a party can answer questions about a document it sent or received.
   - Code drops sentences with figures that appear nowhere in the real case, its documents included. Only real attachments get through.
   - The simulator also judges each email the agent sends against the real case: `on_track`, `over_request` (nothing it asks for is in the real case; when part of it is, the counterparty answers that part, says the rest isn't available, and the UI marks the email "Partly unavailable") or `extra_message` (the real broker never sent anything like it). A verdict listed in `failOn` in `config/settings.json` ends the run as failed. Over-asking costs you, as it would with a real customer.
4. Steps 2 and 3 repeat until the agent closes the case, an email fails the check above, nobody replies twice in a row, or `maxWorldTurns` is reached.
5. **Reviewer.** It decides whether the agent did the right thing at the escalation point. It compares the answer, and what the agent actually did there, with the case's own Overview and Next action at escalation, and returns `correct` or `incorrect` with reasons (`prompts/reviewer.*`). Its decision is the **Correct escalations** headline metric; a run without a reviewer falls back to the judge's first action.
6. **Judge.** It compares the replay with the real case, and reads the documents the agent held, so a figure taken from an attachment is not mistaken for an invented one. Its end-to-end verdict is the other headline metric:
   - **Solved end to end**: the whole replay, from the takeover until the dialogue with the simulated parties ends, is correct and follows the real case.

   It also reports:
   - the first action against the case's "Next action at escalation";
   - each act of correspondence the real handler made, and whether the agent covered it;
   - extras the agent did;
   - violations.

## Sub-agents

The agent can hand any task to a sub-agent with the `run_subagent` tool. It writes the instruction itself; nothing is predefined. The tool description gives a few examples: a reviewer for a draft, a policy-wording searcher, a web precedent search, a simplifier. A sub-agent sees the case as it stands. It can read it, search and read the other claims in the database (never the one being worked on), and use web search and fetch. It reports back as the tool result and never acts. Several `run_subagent` calls in one response run in parallel.

The main agent checks completeness before acting and before every final answer, including simple cases. For complex or uncertain cases, one sub-agent derives required actions from the case without the main agent's plan; another reviews the full proposed action set. Research addresses a named uncertainty. The main agent waits for relevant reviews and verifies findings against the evidence. Each successful tool reply includes `prompts/subagent.result.md`, asking it to record whether each material finding was acted on, deferred with a dependency or rejected with a reason. These are model instructions, not an execution gate; the main agent remains the final decision-maker and answer author.

- On by default (`subagents` in `config/settings.json`). Turn it off in **Full → New run** or with `--no-subagents`; the tool is then not offered at all. The model preset is the `subagent` role.
- Prompts: `prompts/subagent.system.md`, `prompts/subagent.user.md`. Tools: the agent's read-only case tools plus `prompts/subagent.tools.json` (the web tools cannot use GitHub: `blocked_domains`).
- A sub-agent gets up to 25 model rounds, 10 web searches and 6 page fetches per round; one that fails or is still working after 15 minutes comes back to the agent as a tool error.
- In the UI, Simple shows each call as a **Sub-agent** step in the agent chat: its task, its work drawn like the agent's (case files, other claims, web searches with the pages they found), its report, cost and time. Full → Agent trace lists the same with its tool calls. Runs made with the earlier advisory council still show their **Advisers** folds and traces.

## Preset panel

Instead of leaving it to the agent, the harness can launch a fixed set of sub-agents itself, each with a brief of its own. Their proposals are appended to the agent's input for that turn (`prompts/agent.panel.md`); the agent decides and only the agent acts. Off by default: set `panel` in `config/settings.json`, or pass `--panel` on the command line.

```bash
npm run run -- --cases insurance-017,insurance-030 --panel all --no-subagents --label panel
```

| Sub-agent | Angle |
|---|---|
| `researcher` | UK rules and guidance (FCA, Financial Ombudsman, ABI, gov.uk) and what UK insurers' wordings say on the clause in question |
| `conservative` | what could go wrong, the smallest safe set of steps |
| `creative` | the move a routine handler would miss |
| `precedent` | how the other claims in the database were handled |
| `simplifier` | the shortest plan that still does the job, and what to leave out |

- `config/panel.json` says who can sit, with which prompt file and when (`first`: only when the agent picks the case up; `every`: before each of its turns). `prompts/panel.task.md` is the task they all get, `prompts/panelist.*.md` the angles.
- They run as ordinary sub-agents: the `subagent` model preset, the same tools and limits. One that fails or times out is shown as "no proposal" and the turn goes on without it.
- `--panel` and `--no-subagents` are independent: with both, only the panel runs; without `--no-subagents` the agent can still launch sub-agents of its own.
- In the UI a sitting is the **Advisers** fold under the turn header in the agent chat, with **trace ›** on each sub-agent; Full → Agent trace lists their proposals, tool calls, cost and time.

## Where things live

| Path | What |
|---|---|
| `prompts/` | Every prompt, template, tool definition and output schema. All model-facing text lives here; none is in code. |
| `config/models.json` | Model presets, sent to the Messages API as-is (model, max_tokens, thinking, effort, betas). |
| `config/settings.json` | Defaults for new runs: the preset per role, loop limits, judge on or off. |
| `config/splits.json` | Insurance dev split (40 claims) and holdout split (10, every 5th claim). |
| `config/panel.json` | The preset panel: per sub-agent its title, prompt file and when it sits. `settings.json` → `panel` picks who sits on a run. |
| `config/escalation.json` | Each claim's escalation point: the agent sees real events 1..`after`. Editable in the UI like the other config. |
| `runs/<id>/` | `run.json` (summary, plus a snapshot of the settings, presets and prompts used) and `cases/<key>.json` (replay, agent transcript, simulator turns, judge). Only the holdout baseline is committed. |
| `src/` | `cases.ts` parser and the handed-folder loader, `answers.ts` the `ANSWER.md` / `REASONING.md` writer, `casefs.ts` file system and extraction, `agent.ts` loop and tools, `subagent.ts` sub-agents, `panel.ts` the preset panel, `simulator.ts`, `run.ts` orchestration and judge, `server.ts`, `cli.ts`. |
| `ui/` | One page, plain JS, no build step. |

You can edit prompts and config in the UI under **Full → Prompts & settings**. Changes apply to the next run, with no restart needed. `npm run check` runs the self-check, and `npm run typecheck` runs the TypeScript compiler.
