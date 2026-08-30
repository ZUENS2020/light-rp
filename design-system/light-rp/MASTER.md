# Light RP · Precise Warmth Design System

> Page files in `pages/` override this master only where they are more specific.

**Updated:** 2026-08-30

**Product:** private role-play studio
**Design dials:** variance 3/10 · motion 2/10 · density 6/10

## Principles

- Industrial minimalism with warmth: geometric order, quiet surfaces, precise copper accents.
- The interface is a working studio, not a marketing page. Content and state stay legible under long sessions.
- Use borders and spacing for hierarchy; reserve shadows for floating menus, sheets, and dialogs.
- Never use gradients, decorative animation, emoji icons, or layout-shifting hover transforms.

## Tokens

| Role          |     Light |      Dark |
| ------------- | --------: | --------: |
| Background    | `#F2EFE8` | `#211F1B` |
| Surface       | `#FAF8F3` | `#282621` |
| Foreground    | `#282722` | `#EEE9DF` |
| Primary       | `#383631` | `#E8E1D5` |
| Secondary     | `#716B61` | `#AAA195` |
| Accent / ring | `#A2603C` | `#C9825A` |
| Muted         | `#E9E4DA` | `#312E28` |
| Border        | `#D8D1C5` | `#474239` |
| Destructive   | `#B5483F` | `#E07B72` |

Typography uses bundled `Inter Variable` for display, body, and controls. Structured identifiers, token metrics, provider names, and cache states use `JetBrains Mono Variable`. Chinese fallbacks are PingFang SC and Noto Sans CJK SC. Body copy is 16px/1.6; transcript width is capped around 42rem.

Spacing follows a 4px grid: 4, 8, 12, 16, 24, 32, 48, 64. Interactive targets are at least 44px. Corners are restrained (4–12px); status pills may be fully rounded.

## Components

- Buttons: one copper primary action per local decision area; secondary and ghost actions remain graphite. Hover changes color/opacity without movement.
- Inputs: 44px minimum height, 1px border, surface background, visible label, copper 2px focus ring.
- Panels: 1px borders and transparent/surface fills. Avoid nested card stacks.
- Floating UI: low warm shadow, explicit z-index scale—header 10, composer 20, sheet 30, modal 40.
- Status: compact monospaced labels. Cache `HIT` uses copper; `MISS` and `unknown` use secondary; `BYPASS` uses a dashed border.
- Icons: Lucide outline only, normally 16–20px.

## Responsive system

- `1440+`: resource navigation, transcript, and context inspector form three columns.
- `1024–1279`: resource navigation remains; context inspector moves to a right sheet.
- `768–1023`: single transcript column; both auxiliary areas use sheets; model remains in the title bar.
- `<768`: single main column; resource sheet exposes world, characters, lorebooks, sessions, and settings. Context sheet exposes scene, memory, cache, and runtime model selection.

Verify at 375, 768, 1024, and 1440px with no horizontal overflow.

## Interaction and accessibility

- Always show loading feedback for asynchronous actions; generation locks model selection because the queued task already owns an immutable model snapshot.
- Keep keyboard focus visible. Use semantic labels, live regions for generation state, and a transcript skip link.
- Respect `prefers-reduced-motion`; no infinite decorative animation. Spinners are allowed only as state feedback.
- Body contrast must meet 4.5:1 in both themes. Do not rely on color alone for cache or error state.

## Delivery checklist

- [ ] No gradients, emoji icons, or layout-shifting hovers.
- [ ] All controls are labeled, keyboard reachable, and at least 44px.
- [ ] Loading, empty, error, disabled, cache, and task states are explicit.
- [ ] Responsive behavior is verified at 375, 768, 1024, and 1440px.
- [ ] Dark theme, reduced motion, focus ring, and horizontal overflow are checked.
