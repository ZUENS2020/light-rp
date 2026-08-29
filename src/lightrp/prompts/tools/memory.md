Bounded persistent memory for this roleplay world. Use it for facts that should survive later turns: world state, player facts, and per-character notes.

Actions:
- add: append `content` as a new entry
- replace: find the unique entry containing `old_text` and set it to `content`
- remove: find the unique entry containing `old_text` or `content` and delete it

Targets:
- world: shared world facts (MEMORY.md)
- player: facts about the player (PLAYER.md)
- character: requires `character_id` from the cast

Keep entries short. If the store is at capacity, replace or remove before adding. Mid-session writes are saved immediately but the system prompt snapshot will not refresh until compact or a new session.
