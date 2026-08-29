# Page: Play

Overrides MASTER for the RP workspace.

- Layout: desktop two-pane (story + world state). Mobile: story full width, world state in a right Sheet (not a Dialog).
- Transcript is long-form: Libre Baskerville, 16px/1.7, max-width ~42rem, never edge-to-edge on large screens.
- Composer is sticky, labeled, 16px minimum, Enter sends / Shift+Enter newline. Disable + spinner while the model runs.
- Scene / cast / memory use Accordion. Memory and scene YAML use a monospaced UI face so data stays scannable.
- Skip link to `#transcript`. Header back control is a real link to `/` (predictable back + deep linking via `/w/:world/s/:session`).
- Loading: skeleton for first state fetch; composer button shows status for turns >300ms. Never freeze the page.
- z-index scale: header 10, composer 20, sheet 30, modal 40. No arbitrary 9999.
- Dark mode uses the same tokens inverted; body contrast stays ≥4.5:1.
