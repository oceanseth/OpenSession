# OpenSession Desktop

Electron app that turns your starred repos' `llm-turn-history.jsonl` logs into a
Slack-style workspace — repos in the sidebar, each declared session a `#channel`,
turns rendered as chat — and lets you benchmark every turn in a repo inside a
disposable [Daytona](https://www.daytona.io/) sandbox, producing a citable JSON
report.

It reuses the web app's parser and GitHub client (`app/src/lib`, aliased as
`@oslib`) so both surfaces read archives with identical `(ts, id)` ordering,
id-dedupe, and v0.4 `sid` session-binding semantics.

## Run

```sh
cd desktop
npm install
npm run dev      # vite + electron with live reload
npm run build    # typecheck + bundle renderer to dist/
npm start        # electron against the built dist/
```

## Sign in

Two doors, same as the web feed:

- **Device flow** — paste the OAuth app client id (or set `VITE_OAUTH_CLIENT_ID`
  at build time). Enable *device flow* on the GitHub OAuth app; no client secret
  is involved. The main process talks to `github.com` directly, so there is no
  CORS ceremony.
- **Personal access token** — paste a PAT; read-only scopes are enough.

## Benchmarks

`bench/run-bench.mjs` is a dependency-free script that fetches a repo's history
file, parses it, and scores every turn. Three v0 benchmarks:

| id | what it checks |
|----|----------------|
| `structure-integrity` | ULID ids, timestamps, session binding, parse errors |
| `turn-stats` | per-speaker volume + tool-activity coverage on model turns |
| `delusion-heuristic` | model turns making confident completion claims with no recorded tool activity |

**Run in Daytona** ships the script into a fresh sandbox (created via
`@daytonaio/sdk` with your API key), runs it there, records the sandbox id in
the report, and deletes the sandbox. **Run locally** executes the identical
script on your machine — same output, minus the clean-room provenance.

Reports (`opensession-bench-report/v0`) are exportable JSON: summary score,
per-session rollup, and per-turn findings. Commit one to the repo or attach it
to a session thread for public visibility.

## Roadmap

- Publish reports to the OpenSession registry (public, keyed by repo + commit)
- Peer-to-peer bench credits: your worker benches a peer's flagged sessions,
  earning priority for your own — BitTorrent-style reciprocity, with the
  registry as tracker
- Human `delusion` tags on turns gating automatic sandbox re-verification
- LLM-judged benchmarks alongside the heuristic ones
