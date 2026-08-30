# Page: Settings

- Lead with the bound Gateway ID and explain that upstream credentials remain in Gateway BYOK.
- Runtime model registry lists transport/provider, context, tools, revision, enabled/probe state, recent prefix cache ratio, saved tokens, and cold starts.
- New model configs stay disabled until both text and tool probes pass. Probe progress and failure are explicit.
- Group remaining fields with labeled fieldsets: generation, Nowledge Mem, and budget/memory.
- Never expose or round-trip upstream keys. Do not show obsolete base URL, model, or NVIDIA credential inputs.
- Save status states that stable prompt changes rotate the epoch and apply from the next request.
