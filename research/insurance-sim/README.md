# Insurance track: next-action simulation

How automatable is the broker's "next action"? We replay every broker decision in the 50 public
Insurance Claims Processing cases (146 decisions): the model sees only the history up to that point,
proposes the next action, and Claude Opus 5 grades it against what the broker actually did
(match / partial / wrong, plus a harmful flag).

| Setup | Full match | Harmful | Says "auto-send" | …and is right |
|---|---|---|---|---|
| Sonnet 5, plain prompt | 75% | 1% | 47% | 72% |
| Sonnet 5, rules prompt | 60% | 1% | 68% | 51% |
| Haiku 4.5, rules prompt | 73% | 1% | 92% | 74% |
| Opus 5, rules prompt | 70% | 0% | 58% | 60% |
| **Sonnet 5, tuned prompt (`sonnet5_v2`)** | **85%** | 0% real | 63% | 87% |

`sonnet5_v2` was tuned on odd-numbered cases only. On the held-out even cases it scores 77% vs 71% for the
plain prompt (73 decisions each, so the gap is near run-to-run noise). The prompt is `V2` in `sim.py`.

Almost nothing is outright wrong; most misses are an extra "verify records first" step. One of the
remaining harmful flags (case 040) is a dataset artifact: the judge expected the broker to repeat a
"these images are synthetic" disclaimer.

Open [`webapp/sim.html`](webapp/sim.html) locally for the interactive view (per-model cards, case-type
heatmap, every decision with the broker's real action vs each model's proposal).

## Run

```bash
export ANTHROPIC_API_KEY=...            # or AWS_BEARER_TOKEN_BEDROCK (+ AWS_BEDROCK_REGION)
export CASES_DIR="/path/to/HackatonPublicCases/Insurance Claims Processing"
python3 sim.py sonnet5_v2 --cases odd   # writes out/sonnet5_v2.json; also --retry, --rejudge, --report
python3 viz.py                          # rebuilds webapp/sim.html
python3 webapp/build.py                 # full case browser -> webapp/index.html (embeds attachments, ~13 MB)
```
