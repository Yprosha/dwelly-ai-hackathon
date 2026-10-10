# Case Lab

An agent that works the **Insurance Claims Processing** cases end to end against simulated counterparties, plus a UI to read what happened. It is modelled on claimsorted's Sophie Lab: copilot loop, claim-as-file-system tools, replay-engine counterparty and comms-checklist judge, all simplified.

```bash
cd research/case-lab
npm install
npm start
```

Then open http://localhost:5177.

- **API key:** read from the repo's root `.env` or `research/case-lab/.env` as `ANTHROPIC_API_KEY`. Both are gitignored.
- **Cases:** read from `data/public-cases/Insurance Claims Processing`, the same place `research/insurance-sim` uses. Set `CASES_DIR` to read them from somewhere else.
- **Baseline:** `runs/` ships with the holdout baseline, so the UI has something to show straight away. New runs stay local. That baseline was made before escalation starts and began at the opening; the UI says where each run started.

The UI has two modes, like Sophie Lab:

- **Simple** is for reviewing. It has a scorecard, the claim list, an "Agent vs the real claim" fold, an Emails mailbox (this run or the real claim) and the agent's Chat. The claims list and the Emails column can be dragged by their edge or hidden with the chevron on it (double-click the edge to reset), to give the chat more room.
- **Full** is for building. It has the agent trace with thinking and tokens, simulator turns, judge details, a side-by-side replay, run config, New run, and Prompts & settings.

To run from the terminal instead (runs show up in the UI either way):

```bash
npm run run -- --split holdout --label baseline
```

```bash
npm run run -- --cases insurance-032,insurance-037 --agent sonnet-5.5 --no-judge
```

## Cases

- **Public claims** (50): the Insurance Claims Processing cases, with a real history after the escalation point that the simulator replays.
- **Synthetic eval cases** (22, `eval-101`…`eval-113` hard, `eval-201`…`eval-209` complex): read from `eval/cases` (`EVAL_CASES_DIR`). Their history ends at the escalation point, so the agent gets all of it, writes its answer and stops; there is no simulated future and no judge. The reviewer grades the answer against the case's `expected_answer.md` (complex set) and `rubric.json`. Neither file is ever shown to the agent.
- Splits in `config/splits.json`: `holdout`, `dev`, `synthetic`; `--split all` runs everything.

## How a case runs

1. **Handover at the escalation point.** Every public case has a "Next action at escalation" note that refers to one moment in its history. The agent starts there: it is handed, word for word, every real event up to that point, the real handler's own earlier messages among them, and nothing that came after. The points live in `config/escalation.json` (`after` = the last real event the agent sees), taken from `eval/public_escalation_points.json`.
   - Set `startAt` to `opening` to start from the beginning instead: the simulator then delivers every real event before the broker first writes to anyone.
   - Set `seedEvents` to N to hand over the first N real events, whatever `startAt` says.
2. **Agent turn.** The agent reads the case through `list_case`, `read_case` and `search_case`, then acts with `send_message`, `add_note` or `close_case`. Ending its turn without a tool call means "wait for replies".
   - The case is exposed as files: `/case`, `/messages/NNN`, and `/documents/NAME` (attachments as text).
   - The agent is not shown the case card (`index.md`): it was written after the case closed, and its title, request summary and details give away things the handler did not have in the history yet. `/case` only says who the agent is. `caseCard` in settings can add the broker, insurer and property on record (`record`) or the whole card (`full`); the simulator and the judge always get the whole card.
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

- On by default (`subagents` in `config/settings.json`). Turn it off in **Full → New run** or with `--no-subagents`; the tool is then not offered at all. The model preset is the `subagent` role.
- Prompts: `prompts/subagent.system.md`, `prompts/subagent.user.md`. Tools: the agent's read-only case tools plus `prompts/subagent.tools.json` (the web tools cannot use GitHub: `blocked_domains`).
- A sub-agent that fails or is still working after five minutes comes back to the agent as a tool error.
- In the UI, Simple shows each call as a **Sub-agent** step in the agent chat: its task, its work drawn like the agent's (case files, other claims, web searches with the pages they found), its report, cost and time. Full → Agent trace lists the same with its tool calls. Runs made with the earlier advisory council still show their **Advisers** folds and traces.

## Where things live

| Path | What |
|---|---|
| `prompts/` | Every prompt, template, tool definition and output schema. All model-facing text lives here; none is in code. |
| `config/models.json` | Model presets, sent to the Messages API as-is (model, max_tokens, thinking, effort, betas). |
| `config/settings.json` | Defaults for new runs: the preset per role, loop limits, judge on or off. |
| `config/splits.json` | Insurance dev split (40 claims) and holdout split (10, every 5th claim). |
| `config/escalation.json` | Each claim's escalation point: the agent sees real events 1..`after`. Editable in the UI like the other config. |
| `runs/<id>/` | `run.json` (summary, plus a snapshot of the settings, presets and prompts used) and `cases/<key>.json` (replay, agent transcript, simulator turns, judge). Only the holdout baseline is committed. |
| `src/` | `cases.ts` parser, `casefs.ts` file system and extraction, `agent.ts` loop and tools, `subagent.ts` sub-agents, `simulator.ts`, `run.ts` orchestration and judge, `server.ts`, `cli.ts`. |
| `ui/` | One page, plain JS, no build step. |

You can edit prompts and config in the UI under **Full → Prompts & settings**. Changes apply to the next run, with no restart needed. `npm run check` runs the self-check, and `npm run typecheck` runs the TypeScript compiler.
