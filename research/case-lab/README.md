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
   - Code drops sentences with figures that appear nowhere in the real case. Only real attachments get through.
4. Steps 2 and 3 repeat until the agent closes the case, nobody replies twice in a row, or `maxWorldTurns` is reached.
5. **Judge.** It compares the replay with the real case. Two verdicts are the headline metrics of a run:
   - **Correct escalations**: the agent's first action against the case's "Next action at escalation";
   - **Solved end to end**: the whole replay, from the takeover until the dialogue with the simulated parties ends, is correct and follows the real case.

   It also reports:
   - each act of correspondence the real handler made, and whether the agent covered it;
   - extras the agent did;
   - violations.

## Where things live

| Path | What |
|---|---|
| `prompts/` | Every prompt, template, tool definition and output schema. All model-facing text lives here; none is in code. |
| `config/models.json` | Model presets, sent to the Messages API as-is (model, max_tokens, thinking, effort, betas). |
| `config/settings.json` | Defaults for new runs: the preset per role, loop limits, judge on or off. |
| `config/splits.json` | Insurance dev split (40 claims) and holdout split (10, every 5th claim). |
| `config/escalation.json` | Each claim's escalation point: the agent sees real events 1..`after`. Editable in the UI like the other config. |
| `runs/<id>/` | `run.json` (summary, plus a snapshot of the settings, presets and prompts used) and `cases/<key>.json` (replay, agent transcript, simulator turns, judge). Only the holdout baseline is committed. |
| `src/` | `cases.ts` parser, `casefs.ts` file system and extraction, `agent.ts` loop and tools, `simulator.ts`, `run.ts` orchestration and judge, `server.ts`, `cli.ts`. |
| `ui/` | One page, plain JS, no build step. |

You can edit prompts and config in the UI under **Full → Prompts & settings**. Changes apply to the next run, with no restart needed. `npm run check` runs the self-check, and `npm run typecheck` runs the TypeScript compiler.
