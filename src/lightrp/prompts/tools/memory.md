Bounded persistent memory for this roleplay world. Use it for facts that should survive later turns: world state, facts others have learned about the player, and per-character notes. Do not rewrite the user's own setting (PLAYER.md).

Actions:
- add: append `content` as a new entry
- replace: find the unique entry containing `old_text` and set it to `content`
- remove: find the unique entry containing `old_text` or `content` and delete it

Targets:
- world: shared world facts (MEMORY.md)
- player: what the world has learned about the player (PLAYER_MEMORY.md), never the user's own setting
- character: requires `character_id` from the cast

Keep entries short. If the store is at capacity, replace or remove before adding. Mid-session writes are saved immediately but the system prompt snapshot will not refresh until compact or a new session.
