Bounded persistent memory for this roleplay world. Use it for facts that should survive later turns: world state, facts others have learned about the player, and per-character notes. Do not rewrite the user's own setting (PLAYER.md).

When proposing new lasting facts in the trailer, prefer `memory_candidates` with:
- type: promise | relationship | fact | preference | goal | important_event
- text: short fact
- importance: 0.0–1.0 ( ≥0.7 long-term, 0.4–0.7 event log only, <0.4 discard )

Ordinary filler (drank water, walked a corridor) should stay out of long-term memory.

Actions:
- add: append `content` as a new entry
- replace: find the unique entry containing `old_text` and set it to `content`
- remove: find the unique entry containing `old_text` or `content` and delete it

Targets:
- world: shared world facts (MEMORY.md)
- player: what the world has learned about the player (PLAYER_MEMORY.md), never the user's own setting
- character: requires `character_id` from the cast

Keep entries short. If the store is at capacity, replace or remove before adding. Mid-session writes are saved immediately but the system prompt snapshot will not refresh until compact or a new session.
Duplicate or near-duplicate facts should not be added again.
