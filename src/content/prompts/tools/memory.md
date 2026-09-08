Hermes-style bounded persistent memory for this roleplay world. Use it for curated facts that should survive later turns: world state, facts others have learned about the player, and per-character notes. Do not rewrite the user's own setting (PLAYER.md).

Character cards own personality, speaking style, temperament, and lasting character rules. Never write those into memory (no “性格变成…”, speech-style overrides, 扣分规矩, 服从观察员, or similar). If a beat only changes how someone should sound or behave as a persona, leave it out — the card already governs that.

When proposing new lasting facts in the trailer, prefer `memory_candidates` with:
- type: promise | relationship | fact | preference | goal | important_event
- text: short fact
- importance: 0.0–1.0 ( ≥0.7 long-term, 0.4–0.7 event log only, <0.4 discard )

Type policy:
- promise / goal: concrete plot commitments only (appointments, favors, deadlines) — not personality vows or obedience rules
- relationship: interpersonal stance/history between people
- fact / important_event: what happened in the world or to someone
- preference: learned likes/dislikes from play — not temperament rewrites

Ordinary filler (drank water, walked a corridor) should stay out of long-term memory.

Actions:
- add: append `content` as a new entry
- replace: find the unique entry containing `old_text` and set it to `content`
- remove: find the unique entry containing `old_text` or `content` and delete it

Targets:
- world: shared world facts (MEMORY.md)
- player: what the world has learned about the player (PLAYER_MEMORY.md), never the user's own setting
- character: requires `character_id` from the cast; unknown ids are rejected

Keep entries short. Prefer one `operations` batch when consolidating: remove/replace stale entries and add the new fact together; the final character budget is checked atomically. If a write fails, use the returned live entries to revise the batch, but stop after three failed attempts and continue the reply. Writes are durable immediately; the prompt epoch keeps a frozen core snapshot and receives later memory changes as append-only hidden events.
Duplicate or near-duplicate facts should not be added again.
