# dwelly-ai-hackathon

Submission for the **Real-World Agents Hackathon** (10 October 2026).

- **Team:** TODO
- **Track:** TODO (Insurance Claims Processing / Property Management / Banking & Financial Services / Delivery & Logistics)
- **Demo video:** [`demo/`](demo/) — TODO exact file path
- **Reality Test results:** [`ANSWERS/`](ANSWERS/)
- **Submission metadata:** [`SUBMISSION.md`](SUBMISSION.md)

## 1. What we built

TODO

## 2. What operational problem it solves

TODO

## 3. Architecture

TODO — components, data flow, where the model is called, which tools the agent can use, how escalation to a human works.

## 4. How to run

### Prerequisites

- Python 3.10+
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
| `ANTHROPIC_API_KEY` | yes | Model calls |
| `ELEVENLABS_API_KEY` | no | Voice features |

### Run

TODO — exact command that processes a folder of cases and writes `ANSWERS/`.

## 5. Models, APIs and external services

| Service | Used for |
|---|---|
| TODO | TODO |

## 6. Assumptions

TODO

## 7. Known limitations

TODO

## 8. What we would build next

TODO

## Repository layout

| Path | Contents |
|---|---|
| `src/agent/` | Agent source code |
| `data/` | Synthetic operating environment provided at the event |
| `ANSWERS/<n>/ANSWER.md` | Final result for Reality Test case `n` |
| `ANSWERS/<n>/REASONING.md` | What the system received, actions taken, escalations, failures |
| `logs/` | Run logs and traces |
| `demo/` | 60-second demo video (Git LFS) |

All files in `ANSWERS/` are produced by the submitted system and are not edited by hand.

## License

[Apache License 2.0](LICENSE)
