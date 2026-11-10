# ProHarness — Design System

**Mode:** Operate. The user completes tasks. Scanability, state clarity, and native expectations
outrank expression. The brand lives in precise details.

**World:** Warm technical workbench. Charcoal paper, copper action, hairline structure, serif
display against mono utility. Everything is legible at a glance; nothing looks like a generic
SaaS dashboard.

## Tokens

The portable system is in `tokens.css` at the repo root. Components reference named tokens only.
No raw hex/OKLCH values in component CSS, except the xterm canvas theme which cannot resolve CSS
custom properties.

### Color roles

| Token | Role |
| --- | --- |
| `--color-bg` / `--color-bg-deep` | canvas and recessed canvas |
| `--color-surface` / `--color-surface-raised` | rail, inspector, dialogs |
| `--color-line` / `--color-line-strong` | hairlines, separators, edges |
| `--color-ink` / `--color-ink-soft` / `--color-muted` / `--color-faint` | four-step text hierarchy |
| `--color-accent` / `--color-accent-soft` | copper action, live state, selected goal |
| `--color-success` | clean state, completed, approved |
| `--color-warning` | reviewer rejection, auto-approve warning |
| `--color-danger` | high risk, destructive action, failed |
| `--color-info` | links, hunk metadata, user identity |
| `--color-diff-*` | diff line semantics |

Accent discipline: accent marks the next action and live state. It is not a decorative wash.
Success and danger are semantic only.

### Type

- Display: Iowan Old Style / Palatino / Georgia. Used for product headings, goal titles, and
  editorial empty states. Roman only; no italic headings.
- Body: Avenir Next / Segoe UI Variable / system sans. Used for prose and controls.
- Mono: SF Mono / JetBrains Mono / Cascadia / Roboto Mono. Used for ids, paths, metadata, labels,
  terminal, diffs. Mono never exceeds ~0.75rem in dense panels.

Scale: `--text-2xs` through `--text-display`. Body copy is 0.875rem; dense panel metadata is
0.625–0.75rem. Headings use tight tracking and generous display sizes only in empty states.

### Space & shape

4pt scale (`--space-3xs` 2px through `--space-3xl` 72px). Radii max out at 12px for panels,
18px reserved. Hairlines are 1px; 2px rules mark emphasis only. No floating cards with 24px
rounding.

### Motion

- 120ms for hover/press, 180ms for panel reveals, 320ms for rail/workbench width.
- Only `transform`, `opacity`, and width (layout panels). No bouncing, no parallax, no scroll
  hijacking.
- Streaming caret and live dot are the only perpetual animations. `prefers-reduced-motion` and a
  settings toggle collapse all motion.

## Layout

Three-column workbench split:

```text
┌ app bar ────────────────────────────────────────────────┐
│ plan rail (258) │ transcript (flex) │ workbench (410)   │
└ status bar ─────────────────────────────────────────────┘
```

The rail and workbench collapse, with persisted-in-session state. At 1320/1160px the side columns
narrow before content. No horizontal scroll at the window's 1080px minimum.

The center column is a transcript, not a card. The composer pins to the bottom and carries the
goal/next-task context above it. The workbench tabs keep one inspector mounted at a time; the
terminal stays mounted so its buffer survives tab switches.

## Components

- **Buttons** have eight states in CSS: default, hover, focus-visible, active, disabled, loading
  (spinner inheritance), error/danger variant, success variant. Minimum hit target 28px.
- **Inputs** use recessed surfaces, mono type, 1px line, focus border accent. Labels are mono,
  uppercase, 10px.
- **Permission modal** uses a warning glyph, risk chip, origin, tool name, formatted JSON, and
  three decisions. High-risk defaults focus Deny. Escape denies.
- **Diff** uses two line-number columns and a color-coded content column, with hunk/meta styling.
- **Plan rail** uses goal cards with a 2px progress track, then a phase/task tree; completed tasks
  are struck through rather than hidden.
- **Loop** uses a step strip, current task card, independent review card, live agent stream,
  committed list, and a timestamped log.
- **Toast** is bottom-right above the status bar; silent success is preferred over confetti.

## Interaction rules

- Never put an approval on a stray keystroke. Modal focus starts on Deny when risk is high or the
  SDK says `defaultToNo`.
- Destructive diff restore requires a second click ("Confirm restore").
- The loop's auto-approve switch is off by default in copy emphasis but defaults on for autonomous
  operation; its warning is always visible while on.
- Empty states explain the next concrete action and link to it.
- The shell is not sandboxed; the composer footer says so.

## Accessibility floor

- Visible `:focus-visible` ring on every interactive element at ≥3:1 against adjacent color.
- Dialogs use `role="dialog"`, `aria-modal`, labelled headings, and Escape-to-close.
- Status is never color-only: labels accompany dots and verdict colors.
- Motion honors `prefers-reduced-motion` and the settings toggle.
- Tab order follows visual order; the plan rail's task checkbox and body are separate controls.

## Forbidden

- Re-drawn browser/IDE chrome.
- Purple gradient SaaS styling.
- Italic display headings.
- Stat blocks with invented metrics.
- Fake build windows or terminal screenshots.
- Decorative animation that does not communicate state.
