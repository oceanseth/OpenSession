# OpenSession × RocketRide

Runs the turn-benchmark heuristics as a [RocketRide](https://rocketride.ai) Cloud
pipeline — the sponsor integration for the SF Enterprise Hackathon (theme:
"Grounded Agentic Applications with RocketRide Cloud and Linkup").

## What it is

`heuristics.pipe.json` expresses the bench as a RocketRide pipeline:

```
parse → heuristics → [ground (Linkup) → judge (LLM)] → report
```

- **parse / heuristics / report** reuse the same deterministic logic as the
  local runner (`../bench/run-bench.mjs`): structure-integrity, turn-stats,
  delusion-heuristic.
- **ground** (Linkup) web-searches the factual claims in delusion-flagged turns.
- **judge** is a grounded LLM node that decides, per flagged turn,
  confirmed-delusion vs refuted with a cited reason — turning the heuristic
  tripwire into a grounded verdict.

The output is the same `opensession-bench-report/v0` shape the desktop app and
Daytona path already render, with `runner.kind = "rocketride"`.

## Run it

```sh
pip install rocketride
export ROCKETRIDE_APIKEY=...        # from cloud.rocketride.ai
python run_heuristics.py oceanseth/OpenSession delusion-heuristic
```

The desktop app calls this same script from the bench panel ("Run on
RocketRide") once a RocketRide key is set in Settings — Daytona does clean-room
execution, RocketRide does grounded judging, so the two sponsors compose.

## Status

- Pipeline definition, Python runner, and desktop wiring are in place and the
  runner/JSON validate.
- **Not yet run end-to-end against Cloud** — needs a `ROCKETRIDE_APIKEY` (and a
  Linkup key for grounding). The exact node schemas (`tool.linkup`, `llm.chat`,
  `code.js` entry binding) follow docs.rocketride.org and may need small
  adjustments against a live account; the deterministic path is unaffected.
