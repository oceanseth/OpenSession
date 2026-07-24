# OpenSession

**A visualizer and social layer for [Open Session License](./OPEN-SESSION-LICENSE.md) artifacts** — the append-only `llm-turn-history.jsonl` session logs that open-session repos ship alongside their code.

Every project built in collaboration with an LLM under the Open Session License carries a complete, verbatim, append-only history of the human and machine turns that produced it. OpenSession makes those histories **legible, social, and comparable**:

## What it does

- **Realtime session feed.** Watch a live-updating feed of changes to `llm-turn-history.jsonl` files across the GitHub repos you've starred. See how projects are actually being built — turn by turn, human and model — as it happens.
- **Session visualization.** Render open-session-jsonl archives as readable, replayable conversations: speakers, timestamps, tool-activity summaries, identity attestations, and the `(ts, id)` merge order recovered across parallel branches.
- **Discussion threads.** Every session (and every turn) can anchor a chat thread where users discuss what happened, make suggestions, and critique prompting or model behavior.
- **Cross-model evals.** Run the same session prompts through different models and compare — the license's "epistemic self-defense" goal made concrete. See evals attached to sessions in the feed.
- **Linked identity: GitHub ⇄ X.** Users connect their GitHub account and link their X (Twitter) identity. Once linked:
  - GitHub contributions are shown as the X users who made them.
  - Any user can DM any other linked user on X — powered by [xChatHub](./xChatHub) (an in-page Chrome extension that drives X's own DM client, including E2E-encrypted XChat threads).

## Components

| Piece | Role |
|---|---|
| [`OPEN-SESSION-LICENSE.md`](./OPEN-SESSION-LICENSE.md) | The license and the `open-session-jsonl` wire format this app visualizes (pulled from [InfiniteMirror](https://github.com/oceanseth/InfiniteMirror)) |
| [`xChatHub/`](https://github.com/oceanseth/xChatHub) | X DM layer — keyboard-first DM client + WebMCP tools + localhost MCP bridge; the transport for user-to-user messaging |
| `llm-turn-history.jsonl` | This repo's own session history — OpenSession is itself built under the Open Session License |

## Development

The web app lives in [`app/`](./app) — Vite + React + TypeScript (views are kept presentational so they can be reused in a future React Native mobile app):

```bash
git clone --recurse-submodules https://github.com/oceanseth/OpenSession
cd OpenSession/app
npm install
npm run dev    # local dev server
npm test       # vitest (open-session-jsonl parser tests)
npm run build  # production build → dist/
```

`main` is tested locally only. Pushing to the **`production`** branch deploys to
**<https://opensession.groupnetwork.com>** via GitHub Actions
([`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)): OIDC-assumed IAM role →
build → S3 (`opensession.groupnetwork.com`) → CloudFront (`E1ECGJB4KUGGL5`) invalidation.
DNS is a Route53 alias on the `groupnetwork.com` zone.

## Status

Early — the live feed and session visualizer are working (v0 is fully client-side against
api.github.com with a personal access token). Next up: GitHub OAuth login, X identity linking
via xChatHub attestation, discussion threads, and the evals pipeline.

## License

Code is MIT (see `LICENSE`, forthcoming). Session-transparency conditions per the [Open Session License](./OPEN-SESSION-LICENSE.md) apply: the history file is append-only, propagates to forks, and is never loaded as machine context.
