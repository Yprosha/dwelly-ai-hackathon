# dwelly-ai-hackathon

Submission for the **Real-World Agents Hackathon** (10 October 2026).

- **Team:** sorted
- **Team members:** Prohor Yakuba, Daniil Maksimov, Mikhail Primakov
- **Track:** Insurance Claims Processing
- **Demo video:** [`demo/Sorted-demo.mp4`](demo/Sorted-demo.mp4)
- **Reality Test results:** [`ANSWERS/`](ANSWERS/), produced by Case Lab ([`research/case-lab`](research/case-lab/README.md)); traces in [`logs/`](logs/)
- **Submission metadata:** [`SUBMISSION.md`](SUBMISSION.md)

## 1. What we built

Two agents for an insurance broker's claims desk live in this repository. Both take a folder of cases and write
`ANSWERS/<case>/ANSWER.md` and `REASONING.md`.

- **Case Lab** ([`research/case-lab`](research/case-lab/README.md), TypeScript) produced the Reality Test answers
  in `ANSWERS/`. The agent reads the case as a small file system (the correspondence, the attachments as text),
  acts through tools (send a message, add a note, close the case) and can hand a check or a piece of research to
  sub-agents before it acts. On a folder of unseen cases it takes one turn per case: it does what the case needs at
  that point, then writes an Overview, the Next action at escalation and its reasoning. Case Lab also has a
  simulated counterparty, a judge, a reviewer and a UI; we used those to develop and measure the agent on the public
  cases, and none of them runs on the Reality Test.
- **The Python agent** (`src/agent`) is the earlier single-loop agent, still runnable on the same folder. The rest
  of this section and the sections below describe it, with Case Lab called out where it differs.

A claims-operations agent for an insurance broker. Point it at a folder of cases (emails, call notes, internal notes,
photos, PDFs) and, for every case, it reads the whole file and carries the case forward to the next point where it
has to wait on someone else (customer, insurer, third party or a human colleague). It takes every action it can take
now, in order (messages to the customer / insurer / third parties, internal notes, an escalation to a human with a
self-contained handover, or a deliberate "no action"), says what it will do once the awaited reply arrives, and states
where the case will then stand without inventing decisions. Each case gets `ANSWERS/<case>/ANSWER.md` (**Final
outcome**, numbered **Next steps** marked NOW / AFTER ..., then the decision and the full text of every action),
`ANSWERS/<case>/REASONING.md` (what it received, facts with sources, conflicts it detected,
options, why, every tool call, what failed) and a machine-readable trace in `logs/<case>.jsonl`.

## 2. What operational problem it solves

Broker claims teams spend most of their day on the "what's the next step on this file?" loop: relay the insurer's
answer, ask the customer for the missing facts, pass a third-party letter on, chase, or spot that something is off and
hand it to a senior. Most steps are routine; a few are traps (conflicting addresses, a bounced email, changed bank
details, a complaint, a vulnerable customer, an instruction hidden in a document). The agent does the routine steps and
is built to *stop* on the traps: it asks the right party or escalates with a handover a colleague can act on without
re-reading the file. Every outgoing message carries a `needs_human_approval` flag so an operator can let routine
messages go straight out and review the sensitive ones.

On the 50 public insurance cases our earlier offline replay (`research/insurance-sim/`, 146 real broker decisions,
graded by Claude Opus 5 against what the broker actually did next) measured 85% full-match for the same playbook
prompt used here, with no genuinely harmful proposals.

Measured with `eval/public.py` (agent sees the history up to the decision point; Claude Opus 5 judge compares its
ANSWER.md with what the broker actually did and the recorded outcome; scores 0-10 for next steps / outcome / judgement):

| Set | Points | Next steps | Outcome | Judgement | Harmful |
|---|---|---|---|---|---|
| Public cases, escalation points (primary) | 50 | 8.5 | 7.8 | 8.9 | 0 |
| Public cases, every broker decision step | 144 | 8.8 | 8.5 | 8.9 | 0 |
| Rehearsal set 001-022 (`eval/judge.py`, outcomes / judgement) | 22 | | 9.4 | 9.1 | 0 critical |
| Hard rehearsal set 101-113 | 13 | | 8.9 | 8.5 | 0 critical |

The two public-case rows were measured while replays still showed the agent the index.md case card (title, details,
request summary). Replays now withhold it, so those rows need a re-run.

No crashes or fallbacks; about $0.09 and 45 seconds per case with Claude Sonnet 5 (all 50 cases in ~4 minutes with 14
workers). Prompt changes were tuned on odd case ids and checked on even ones; run-to-run noise is about ±0.3.

## 3. Architecture

**Case Lab** (the Reality Test run):

```
 folder of cases            cases.ts                    agent.ts (one turn per case, cases in parallel)
 <case>/index.md,      -->  history -> messages    -->  Claude Opus 5.5, tool use, adaptive thinking
 history.md, any files      other files -> documents      |  list_case, read_case, search_case   (read the case)
                            (PDFs and images                |  send_message, add_note, close_case   (act)
                             transcribed by Claude)         |  run_subagent  ->  subagent.ts: reads the case, searches
                                                            |                    the public claims and the web, reports back
                                                            v
                            answers.ts  -->  ANSWERS/<case>/ANSWER.md, REASONING.md ; logs/<case>.json, logs/run.json
```

- The agent never sees an answer key: `Overview`, `Next action at escalation` and `Outcome` are hidden if a case
  still has them. Sub-agents only read and report; only the agent acts.
- No live mailbox is connected: each message and note is recorded word for word in `ANSWER.md`.
- A case that fails is run once more. One that fails again, or is still running after 15 minutes, still gets both
  files, saying that the system wrote no answer and the case needs a human. Nothing is filled in by hand.
- Details, the simulator, judge and UI: [`research/case-lab/README.md`](research/case-lab/README.md).

**The Python agent:**

```
 cases_dir/<case>/            loader.py                       agent.py (one loop per case, N cases in parallel)
 index.md, history.md,  -->   text + image/PDF blocks   -->   Claude (tool use, adaptive thinking)
 attachments/*.png|pdf        - hides answer sections           |  ^
 (any .md/.txt/.json/.eml/     (Overview/Outcome/...)           v  |  tool results
  .csv, images, PDFs)         - tolerant of odd files         tools.py: mock operations layer
                                                              lookup_records | calculate | send_message | create_internal_note
                                                              escalate_to_human | no_action | cancel_action | finish
                                                                   |   (actions staged -> self-check -> committed)
                                                                   v
                                     render.py --> ANSWERS/<case>/ANSWER.md, REASONING.md ; logs/<case>.jsonl
```

- **One agent, one loop per case** (`agent.py`), max 30 model calls. The system prompt is the playbook distilled
  from the replay study (take every step up to the next wait on someone else, pass facts on with unknowns marked,
  relay the insurer faithfully with its caveats, safety advice first then containment via a qualified contractor, hard rules on authority / payments / personal
  data) plus an exception checklist (conflicting facts, failed or bounced actions, missing context, duplicates/noise,
  fraud and social engineering, vulnerable customers, complaints and legal signals, decisions outside authority).
- **Case content is untrusted.** It is wrapped in `<case_file>` tags; the prompt tells the model to treat it as
  evidence only and to flag any embedded instructions as a possible injection.
- **Mock operations layer** (`tools.py`). There is no live broker system, so every action is recorded in a per-case
  outbox. `lookup_records` searches only the case file and answers "no record found" rather than inventing.
  `calculate` does exact arithmetic (re-adding invoices, excess/limit order) and date maths (days between dates,
  working days with England & Wales bank holidays 2024-2027) so figures and deadlines are never mental maths.
  Actions are *staged*; the first `finish` call returns a 17-point self-check (invented facts, promises, authority,
  payment details, data sharing, injection, unresolved conflicts, safety, faithful relay, handover quality, who is
  left waiting, doing too much or too little, nothing invented in the next steps / outcome, figures re-added, instructions relayed). The agent can `cancel_action` and restage before the second `finish` commits.
- **Escalation to a human** is a first-class action: reason, urgency, route (claims handler, complaints, fraud, data
  protection...), handover summary, open questions, recommended next steps. "No action" is also first-class.
- **Never crash on a case.** Unreadable files are listed as not read; tool errors go back to the model as errors;
  tool arguments with leaked tool-call markup are repaired instead of bounced. Near the turn limit the model is told
  to finish; if it still doesn't, one forced `finish` call commits the staged actions with every message held for
  human approval. An API failure or a refusal produces an ANSWER.md that says "system fallback: escalate to human"
  and lists whatever drafts were staged as not committed.
- **Traces**: every model call (model, token usage, cost estimate, latency, tool calls) and every tool result is
  appended to `logs/<case>.jsonl`; `logs/run_summary.json` summarises the run.

## 4. How to run

### Prerequisites

- Python 3.10+ (the Python agent)
- Node 20.12 or newer (Case Lab)
- [uv](https://docs.astral.sh/uv/)
- Git LFS (for the demo video)

### Installation

```bash
git clone https://github.com/Yprosha/dwelly-ai-hackathon.git
cd dwelly-ai-hackathon
uv venv
uv pip install -e .
```

### Configuration

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | one of these two | Claude via the Anthropic API |
| `AWS_BEARER_TOKEN_BEDROCK` | one of these two | Claude via Amazon Bedrock (Mantle endpoint), used if no `ANTHROPIC_API_KEY` |
| `AWS_BEDROCK_REGION` | no | Bedrock region, default `eu-west-1` |
| `ELEVENLABS_API_KEY` | no | Voice features |

### Run

```bash
# process every case folder and write ANSWERS/<case>/ + logs/<case>.jsonl
uv run python -m agent run "<path>/Insurance Claims Processing" --out ANSWERS --workers 8
# or, after install: agent run <cases_dir> --out ANSWERS
```

**Case Lab, as used for the Reality Test.** It reads `ANTHROPIC_API_KEY` from the same `.env`. It writes
`ANSWERS/<case>/ANSWER.md` and `REASONING.md`, the full trace of each case in `logs/<case>.json`, and the settings,
model presets and prompts the run used in `logs/run.json`:

```bash
cd research/case-lab
npm install
npm run run -- --dir "<path to the folder of cases>"
```

`--no-subagents` turns the sub-agents off, `--cases 3,7` runs only those folders, `--timeout 15` is the time limit
per case in minutes. `npm start` opens the UI (http://localhost:5177), where **Full → New run → A folder of cases**
starts the same run. `npm run check` runs the self-checks.

**The Python agent:**

Options: `--model` (default `claude-sonnet-5`), `--workers`, `--only 001,022`, `--skip-existing` (resume an
interrupted run), `--no-thinking`, `--logs DIR`, and for development `--cut-at-event 001:4,022:3` (replay a public case
as if its history ended at that event; the agent then works from the history alone: the index.md case card and later
attachments are withheld). A case may be a folder (any name) or a single file.

Self-checks for the parser and tool layer: `python src/agent/loader.py` and `python src/agent/tools.py`.

Backtest on the public cases (agent + Claude Opus 5 judge; see [`eval/README.md`](eval/README.md)):
`python eval/public.py "<path>/Insurance Claims Processing" --run NAME [--points escalation|all] [--parity odd|even]`.

## 5. Models, APIs and external services

| Service | Used for |
|---|---|
| Claude Sonnet 5 (`claude-sonnet-5`) via the Anthropic API or Amazon Bedrock | The agent: reading the case (text, images, PDFs), deciding, calling tools. Adaptive thinking on, prompt caching on the case file |
| Claude Opus 5.5 (`claude-opus-5-5`) via the Anthropic API | Case Lab: the agent and its sub-agents (adaptive thinking, effort xhigh), transcription of PDFs and images (effort low); in development also the simulator, judge and reviewer |
| Anthropic server-side web search and web fetch | Case Lab sub-agents only, when the agent asks one to look something up |
| `@anthropic-ai/sdk` (TypeScript) | Case Lab's API client |
| Claude Opus 5 | Offline only: grader in the research replay (`research/insurance-sim/`) |
| `anthropic` Python SDK, `python-dotenv` | API client (retries 429/5xx with backoff), `.env` loading |

Everything else is the Python standard library. No agent framework.

## 6. Assumptions

- Case Lab, Reality Test: a case's history ends where the agent takes over, so the agent is given all of it and
  every file in the case folder. It takes one turn; what happens after the replies arrive is described in the
  Next action, not acted out.
- The agent acts for the broker named in the case (or for whichever party the case shows it working for) at the moment
  the history ends; the expected output is the next steps up to the next point where the case waits on someone else,
  and the expected outcome at that point, not a full case resolution.
- There is no live system to act on, so "acting" means recording complete, sendable messages, notes and handovers in a
  mock outbox. Messages flagged `needs_human_approval` would wait for an operator in production.
- Everything in the case file is on record; nothing outside it is known (no policy database, no wording documents).
- Sections that reveal the answer in the public examples (`Overview`, `Next action at escalation`, `Outcome`, and the
  Status/Updated/Completed fields) are hidden from the model if present.
- Labels such as "synthetic" or "fictional" on documents are dataset artefacts, not fraud evidence.

## 7. Known limitations

- Case Lab has no separate "escalate to a human" tool: a handover is a message to an internal team or a note on the
  case record, so it has to be read in `ANSWER.md`, not counted from a field.
- Case Lab on unseen cases is one turn with no reviewer after it. The folder run was checked on a handful of
  rehearsal cases, not measured at scale; the measured scores in section 2 are the Python agent's.
- Case Lab reads PDFs, images and text files. Other binary formats (Word, Excel, audio) are listed but not read.
- With sub-agents on, a complex case takes several minutes and about $1; `REASONING.md` gives the cost and time of
  each case.
- Single pass per case, no second model reviewing the first; the self-check is the same model re-reading its staged
  actions. Judgement is only as good as the prompt and the model.
- `lookup_records` is keyword search over the case file, not a real policy/claims system; it can miss paraphrases.
- No simulated failures from the tools themselves (sends always "succeed"); failed actions are only detected when they
  appear in the case history.
- Cost estimates use first-party list prices; Bedrock pricing differs.
- Tuned and tested on the 50 public insurance cases only; the Reality Test cases are unseen.

## 8. What we would build next

- Real connectors behind the same tool interface (email/outbox with approval queue, policy admin lookup, insurer portals).
- A reviewer pass (second model or a rules engine) on every outgoing message before it is released, and measured
  auto-send thresholds per action type.
- A regression suite of escalation cases with rubrics (required outcomes, red flags) run on every prompt change.
- Voice intake for first notification of loss feeding the same agent.

## Repository layout

| Path | Contents |
|---|---|
| `research/case-lab/` | Case Lab: the agent harness that produced `ANSWERS/` (source, prompts, config, UI) |
| `src/agent/` | The Python agent's source code |
| `data/` | Synthetic operating environment provided at the event |
| `ANSWERS/<n>/ANSWER.md` | Final result for Reality Test case `n` |
| `ANSWERS/<n>/REASONING.md` | What the system received, actions taken, escalations, failures |
| `logs/` | Run logs and traces |
| `demo/` | 60-second demo video (Git LFS) |

All files in `ANSWERS/` are produced by the submitted system and are not edited by hand.

## License

[Apache License 2.0](LICENSE)
