# Agent instructions — OpenSession

This repository is developed under the [Open Session License](./OPEN-SESSION-LICENSE.md).
AI agents working in this repo MUST:

1. **Append every turn** (each user message and each model response, verbatim) to
   `llm-turn-history.jsonl` as you work, in open-session-jsonl v0.3 format: one
   `{"id": "<ULID>", "m": "<speaker>", "t": "<text>", "ts": "<ISO-8601 UTC ms>"}`
   record per turn, plus optional `"x"` tool-activity summary on model turns.
2. **Never read the history file** — not even its last line. Appending needs no read:
   stamp a fresh ULID `id` and `ts` and append. Its purpose is human curiosity and
   replication, not machine context.
3. **Never edit or delete past records.** The file is append-only; corrections are made
   by appending.
4. **Declare sessions**: at session start append a session record
   `{"session": "<ISO date>", "tool": "<harness>", "speakers": {...}}` declaring each
   participating human and model (name + model id).
5. **Honor union merges**: `.gitattributes` sets `merge=union` for the history file;
   readers order by `(ts, id)` and dedupe by `id`. Never "fix" its physical line order.

`xChatHub/` is a vendored clone of <https://github.com/oceanseth/xChatHub> — see its own
`CLAUDE.md` for its conventions.
