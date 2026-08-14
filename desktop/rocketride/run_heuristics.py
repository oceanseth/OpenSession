#!/usr/bin/env python3
"""
Run the OpenSession turn-heuristics pipeline on RocketRide Cloud.

Fetches a repo's llm-turn-history.jsonl, sends it through the
heuristics.pipe.json pipeline (deterministic benchmarks + an optional
grounded LLM judge over flagged turns), and prints an
opensession-bench-report/v0 JSON object to stdout.

Auth (env, or --api-key / --uri):
  ROCKETRIDE_URI     default https://cloud.rocketride.ai
  ROCKETRIDE_APIKEY  required

Usage:
  pip install rocketride
  ROCKETRIDE_APIKEY=... python run_heuristics.py oceanseth/OpenSession delusion-heuristic
"""
import argparse
import asyncio
import json
import os
import sys
import urllib.request

HISTORY_FILE = "llm-turn-history.jsonl"
PIPE = os.path.join(os.path.dirname(__file__), "heuristics.pipe.json")


def fetch_history(repo: str, branch: str = "HEAD") -> str:
    url = f"https://raw.githubusercontent.com/{repo}/{branch}/{HISTORY_FILE}"
    with urllib.request.urlopen(url) as r:
        if r.status != 200:
            raise SystemExit(f"fetch {r.status} for {url}")
        return r.read().decode("utf-8")


async def run(repo: str, benchmark: str, branch: str, uri: str, api_key: str) -> dict:
    try:
        from rocketride import RocketRideClient
    except ImportError:
        raise SystemExit("rocketride SDK not installed — run: pip install rocketride")

    history = fetch_history(repo, branch)
    async with RocketRideClient(uri=uri, auth=api_key) as client:
        started = await client.use(filepath=PIPE)
        token = started["token"]
        try:
            result = await client.send(
                token,
                json.dumps({"repo": repo, "benchmark": benchmark, "history": history}),
                mimetype="application/json",
            )
        finally:
            await client.terminate(token)
    return result if isinstance(result, dict) else json.loads(result)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("repo", help="owner/name")
    ap.add_argument(
        "benchmark",
        nargs="?",
        default="delusion-heuristic",
        choices=["structure-integrity", "turn-stats", "delusion-heuristic", "all"],
    )
    ap.add_argument("branch", nargs="?", default="HEAD")
    ap.add_argument("--uri", default=os.environ.get("ROCKETRIDE_URI", "https://cloud.rocketride.ai"))
    ap.add_argument("--api-key", default=os.environ.get("ROCKETRIDE_APIKEY", ""))
    args = ap.parse_args()

    if not args.api_key:
        raise SystemExit("set ROCKETRIDE_APIKEY (or pass --api-key)")

    report = asyncio.run(run(args.repo, args.benchmark, args.branch, args.uri, args.api_key))
    report.setdefault("runner", {})["kind"] = "rocketride"
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
