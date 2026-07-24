# The Open Session License, v0.4 (draft)

*Seth Caldwell believes all open source projects that were collaborations with
LLMs should include a complete, append-only history of the human and machine
turns that made them — so anyone can see how the project was actually built,
replay it, audit it, or fork the conversation itself by changing the context
at any turn. This license exists to propagate that practice.*

*The motivations are stated in full in
[Why every human–AI collaboration should ship its session log](docs/why-open-session.md).
In brief: (1) **epistemic self-defense** — an append-only verbatim log lets a
user audit, from a future mental state, whether a past session was sycophantic
manufacture of felt-understanding or the real thing ("AI psychosis" defense:
self-audit, cross-model measurement of the same prompts, expert adjudication
of raw sessions); and (2) **provenance** — publicly timestamped, identity-
attested turns make origination provable, so the community can route
recognition to verified creators and starve extractive copying of its
current free ride.*

## Terms

This project's **code** is licensed under the MIT License (see `LICENSE`).
In addition, by forking, copying, or creating derivative works of this
repository, you agree to the following session-transparency conditions:

1. **Preserve the history.** Keep `llm-turn-history.jsonl` (and this file) in
   your fork. History files are **append-only**: never silently edit or
   delete past records. Corrections are made by appending, not rewriting.

2. **Repeat the practice.** If you develop your fork in collaboration with an
   LLM or other AI agent, log each user turn and each model response to your
   copy of `llm-turn-history.jsonl`, in the format below, as you work.

3. **Keep the machine preface.** The first record of the history file must
   contain a `preface` instructing LLMs and automated agents **not to read
   the file** — its purpose is human curiosity and replication, not machine
   context. Agents append; they do not load. Appending requires no read: a
   writer stamps a fresh `id` and `ts` (see Format) and appends — it never
   needs to open the file, not even its last line. (This is why the monotonic
   `n` of earlier versions was removed: a shared counter forced a read to
   compute the next value and collided across branches.)

4. **Propagate.** Include this license file, unmodified except for version
   updates, in any fork or derivative, so the requirement carries forward.

5. **Attribution of provenance.** Declare each participating model (name and
   model id) and each human in the history file's session records, and the
   session date(s), to the extent known.

6. **Instruct the agents.** An adopting repository SHOULD include an
   `AGENTS.md` at its root (and/or the harness-specific equivalent it loads,
   e.g. `CLAUDE.md`) that directs AI agents to respect this license: append
   each turn to `llm-turn-history.jsonl` as they work, never read or rewrite
   it, and honor the append-only and clean-merge rules. The license states
   the norm; `AGENTS.md` is where each repo turns it into an operative
   instruction the agent actually loads at the start of a session.

## Format (open-session-jsonl v0.3)

One JSON object per line ([JSON Lines](https://jsonlines.org)):

- **Header record** (first line): `{"format": "open-session-jsonl",
  "version": "0.3", "preface": "...", "docs": "SOUL.md"}`
- **Session records** (one at each session start): `{"session": "<ISO
  date>", "tool": "<harness>", "speakers": {"<abbrev>": {"kind":
  "human"|"model", "name": "...", "id": "<model id>"}}}` — speaker
  abbreviations are declared once and reused, compressing every message line.
- **Message records:** `{"id": "<ULID>", "m": "<speaker abbrev>", "t": "<turn
  text, verbatim>", "ts": "<ISO-8601 UTC>"}` plus optional `"x"` (summary of
  tool activity, on model turns). `id` is a globally-unique, time-sortable
  record id — a [ULID](https://github.com/ulid/spec) by convention, whose
  leading timestamp makes a plain lexicographic sort chronological and whose
  entropy keeps it unique across contributors writing at the same instant.
  `ts` is the human-readable ISO-8601 UTC timestamp (millisecond precision,
  fixed width, so string sort equals time sort). **Records are ordered by
  `(ts, id)` at read time, never by position in the file** — so appends from
  parallel branches merge without reordering. The monotonic `n` of v0.2 is
  removed (it required a shared counter, forced a read to compute, and
  collided on merge); readers MAY still accept `n` on legacy v0.2 archives.

- **Clean concurrent merges.** The file is append-only and several
  contributors may push in parallel, so an adopting repo SHOULD enable git's
  union merge for it — add `llm-turn-history.jsonl merge=union` to
  `.gitattributes` (committed once, then applied automatically for everyone).
  Union merge concatenates both sides' appended lines instead of raising a
  conflict; per-record `id` uniqueness makes that safe, and readers dedupe by
  `id`. Correct order is recovered by the `(ts, id)` sort above, so the file's
  physical line order need not be meaningful. Where even that is undesirable,
  a repo MAY instead shard the log into per-contributor/per-session files
  (`sessions/<who>-<ulid>.jsonl`) merged at read time — distinct files never
  conflict.

- **Identity records** (v0.3, for humans — including "multiplayer" sessions
  with several humans): every human speaker SHOULD be keyed to a public
  account (GitHub by convention) in the speakers table, and SHOULD append an
  identity record before their first turn:
  `{"identity": "<abbrev>", "github": "<login>", "github_id": <int>,
  "method": "ssh-signature", "namespace": "open-session", "challenge":
  "<canonical statement>", "pubkey": "<key signed with>", "signature":
  "<SSH signature block>", "verify": "<one-liner>", "ts": "<ISO date>"}`.
  The `ssh-signature` method is reader-verifiable: GitHub publishes each
  account's keys at `github.com/<login>.keys`; the signature is created with
  `ssh-keygen -Y sign -n open-session` and checked with `ssh-keygen -Y
  verify` against those keys. The `pubkey` is pinned in the record because
  the `.keys` endpoint serves only *current* keys — verify against the pinned
  key; its account linkage is attested at signing time. The weaker
  `gh-session` method (the model witnessed `gh api user` returning the login
  during the session) is acceptable when no published key is available.
  Methods form a trust ladder: `gh-session` (witnessed) < `ssh-signature`
  (proves key possession) < **verified human presence — the ideal method**.
  A signature only proves the key holder endorsed a statement; it cannot
  prove a live human was at the keyboard. A human-presence attestation — a
  reader-verifiable proof of liveness issued at session time (e.g. the
  forthcoming voicecert.com API), recorded per session or, ideally, per
  turn — closes that gap, and SHOULD be used as the identity method wherever
  such an attestation service is available. Expected shape:
  `{"identity": "<abbrev>", "method": "voicecert", "attestation": "<signed
  attestation>", "verify": "<public verification endpoint or recipe>"}`.
- **Format-update records:** the header is immutable (append-only file), so
  spec version bumps are announced by appending
  `{"format": "open-session-jsonl", "version": "<new>", "note": "..."}`.

The schema maps one-to-one onto the de-facto chat JSONL standard
(`role`/`content` as used in fine-tuning datasets): `kind: human → role:
user`, `kind: model → role: assistant`, `t → content` (`id` and `ts` are
record metadata the mapping ignores). Converting is a one-liner; keeping that
mapping intact is a condition of this license, so archives remain
machine-consumable by standard tooling.

## Related: the Closed Session License (planned)

The format is useful beyond open source. A **Closed Session License**
(planned, will live in its own repository alongside a localhost analytics
app) applies the same JSONL spec to *private* session archives: sessions are
preserved rather than destroyed, but the license asserts confidentiality —
a machine-readable NDA at the repo root. Agents and tools operating in a
closed-session repository must honor it: no uploading of session data,
repository contents, or derived context to any upstream service beyond what
the user's current instruction strictly requires. (The July 2026 Grok Build
incident — entire git repositories, secrets included, uploaded to a cloud
bucket while a privacy toggle did nothing — is the canonical example of the
behavior this license names as a violation.) Closed-session archives remain
the user's asset: analyzable locally (prompting-evolution statistics,
token-flow trends), monetizable or licensable on the user's terms, and
convertible to open-session by relicensing.

## Notes

- These conditions govern the *session-history practice*; they do not
  restrict use of the code beyond the MIT terms.
- Enforceability of session-transparency conditions is untested; treat them
  at minimum as a binding-in-spirit community norm, in the tradition of
  share-alike licensing.
- v0.1 (2026-07-11) used a plain-text format; v0.2 (same day) switched to
  JSONL with speaker-abbreviation compression; v0.3 (same day) added
  verifiable identity records for human speakers; v0.4 (2026-07-17) dropped
  the monotonic `n` for a time-sortable `id` (ULID) plus a required `ts`,
  ordered records by `(ts, id)`, and adopted `merge=union` for clean parallel
  appends — bumping the wire format to open-session-jsonl v0.3. Drafted within
  the session it archives — see the history file itself.
