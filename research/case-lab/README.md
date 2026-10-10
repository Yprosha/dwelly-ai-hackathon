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

- **Simple** is for reviewing. It has a scorecard, the claim list, an "Agent vs the real claim" fold, an Emails mailbox (this run or the real claim) and the agent's Chat.
- **Full** is for building. It has the agent trace with thinking and tokens, simulator turns, judge details, a side-by-side replay, run config, New run, and Prompts & settings.

To run from the terminal instead (runs show up in the UI either way):

```bash
npm run run -- --split holdout --label baseline
```

```bash
npm run run -- --cases insurance-032,insurance-037 --agent sonnet-5.5 --no-judge
```

## How a case runs

1. **Handover at the escalation point.** Every public case has a "Next action at escalation" note that refers to one moment in its history. The agent starts there: it is handed, word for word, every real event up to that point, the real handler's own earlier messages among them, and nothing that came after. The points live in `config/escalation.json` (`after` = the last real event the agent sees), taken from `eval/public_escalation_points.json`.
   - Set `startAt` to `opening` to start from the beginning instead: the simulator then delivers every real event before the broker first writes to anyone.
   - Set `seedEvents` to N to hand over the first N real events, whatever `startAt` says.
2. **Agent turn.** The agent reads the case through `list_case`, `read_case` and `search_case`, then acts with `send_message`, `add_note` or `close_case`. Ending its turn without a tool call means "wait for replies".
   - The case is exposed as files: `/case`, `/messages/NNN`, and `/documents/NAME` (attachments as text).
   - The agent is not shown the case card (`index.md`): it was written after the case closed, and its title, request summary and details give away things the handler did not have in the history yet. `/case` only says who the agent is. `caseCard` in settings can add the broker, insurer and property on record (`record`) or the whole card (`full`); the simulator and the judge always get the whole card.
   - PDFs and images are transcribed by Claude on first read and cached in `cache/extracted/`.
3. **World turn.** The simulator plays everyone except the handler. It follows the real history, adapts it to what the agent actually wrote, and stays silent when the real parties had nothing left to say.
   - The simulator reads the text of the real attachments, so a party can answer questions about a document it sent or received.
   - Code drops sentences with figures that appear nowhere in the real case, its documents included. Only real attachments get through.
4. Steps 2 and 3 repeat until the agent closes the case, nobody replies twice in a row, or `maxWorldTurns` is reached.
5. **Judge.** It compares the replay with the real case, and reads the documents the agent held, so a figure taken from an attachment is not mistaken for an invented one. Two verdicts are the headline metrics of a run:
   - **Correct escalations**: the agent's first action against the case's "Next action at escalation";
   - **Solved end to end**: the whole replay, from the takeover until the dialogue with the simulated parties ends, is correct and follows the real case.

   It also reports:
   - each act of correspondence the real handler made, and whether the agent covered it;
   - extras the agent did;
   - violations.

## Advisers

Before the agent takes a turn, a council of sub-agents can each propose the next steps from their own angle. The proposals are appended to the agent's input for that turn (`prompts/agent.advice.md`); the agent decides and only the agent acts. Off by default: tick the advisers in **Full → New run**, set `advisers` in `config/settings.json`, or pass `--advisers` on the command line.

```bash
npm run run -- --cases insurance-017,insurance-030 --advisers all --label council
```

| Adviser | Angle | Preset | Tools | Sits |
|---|---|---|---|---|
| `creative` | the move a routine handler would miss | `opus-5.5` | case | every turn |
| `risk` | what could go wrong, the smallest safe set of steps | `opus-5.5-high` | case | every turn |
| `web` | UK rules and guidance (FCA, Financial Ombudsman, ABI, gov.uk) | `opus-5.5` | case, web search and fetch | first turn |
| `wordings` | what UK insurers' policy wordings for this kind of policy say | `opus-5.5` | case, web search and fetch | first turn |
| `precedent` | how the other claims in the database were handled | `opus-5.5-low` | case, `search_claims`, `read_claim` | every turn |

- Advisers differ in prompt, model preset (so in effort) and tools. Current Claude models do not accept a sampling temperature, so that is not one of the settings.
- Everything is config: `config/advisers.json` says who can sit, with which preset, prompt file, tool groups and when; `prompts/adviser.*.md` hold the prompts and `prompts/adviser.tools.json` the tool groups.
- The two web advisers sit only when the agent picks the case up, because reading policy booklets is the expensive part and their findings stay in the agent's conversation. Set `"when": "every"` to have them sit before every turn.
- The precedent analyst reads the other 49 public cases in full, recorded overview and outcome included, and never the case being worked on.
- An adviser that fails or is still working after five minutes is shown as "no proposal" and the turn goes on without it.
- In the UI, Simple shows an **Advisers** fold under each turn header in the agent chat; Full → Agent trace shows each adviser's proposal, tool calls, cost and time.

## Where things live

| Path | What |
|---|---|
| `prompts/` | Every prompt, template, tool definition and output schema. All model-facing text lives here; none is in code. |
| `config/models.json` | Model presets, sent to the Messages API as-is (model, max_tokens, thinking, effort, betas). |
| `config/settings.json` | Defaults for new runs: the preset per role, loop limits, judge on or off. |
| `config/splits.json` | Insurance dev split (40 claims) and holdout split (10, every 5th claim). |
| `config/advisers.json` | The council: per adviser its title, model preset, prompt file, tool groups and when it sits. `settings.json` → `advisers` picks who sits on a run. |
| `config/escalation.json` | Each claim's escalation point: the agent sees real events 1..`after`. Editable in the UI like the other config. |
| `runs/<id>/` | `run.json` (summary, plus a snapshot of the settings, presets and prompts used) and `cases/<key>.json` (replay, agent transcript, simulator turns, judge). Only the holdout baseline is committed. |
| `src/` | `cases.ts` parser, `casefs.ts` file system and extraction, `agent.ts` loop and tools, `council.ts` advisers, `simulator.ts`, `run.ts` orchestration and judge, `server.ts`, `cli.ts`. |
| `ui/` | One page, plain JS, no build step. |

You can edit prompts and config in the UI under **Full → Prompts & settings**. Changes apply to the next run, with no restart needed. `npm run check` runs the self-check, and `npm run typecheck` runs the TypeScript compiler.
