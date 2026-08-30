# Page: Play Studio

- Desktop at 1440px is a three-column studio: 256px resources, flexible transcript, 320px context inspector.
- The title bar includes the runtime model, provider/source, context window, tool capability, current prompt epoch, theme, and auxiliary controls.
- Model selection is locked during generation and only affects the next queued turn.
- The context inspector is pinned to the desktop viewport and never follows transcript scrolling; its Scene, Memory, and Cache tabs scroll internally.
- Memory shows the bounded Hermes-style core stores, latest `RP-mem` recall count, asynchronous nmem sync state, errors, and an explicit workspace resync action.
- Cache shows stable prefix, volatile increment, epoch, output-contract tokens, prefix cache ratio, and Gateway HIT/MISS/BYPASS/unknown.
- At 1024px collapse the inspector; below 1024px collapse resources. At 375px resource and context sheets expose all auxiliary capabilities, including runtime model selection.
- Transcript remains a single readable column around 42rem. Composer is always reachable and reports pending state without freezing navigation.
- Skip link targets the transcript. Enter sends, Shift+Enter inserts a newline.
