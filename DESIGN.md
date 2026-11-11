# ProHarness: design system

A dense, calm, dark macOS developer tool. Tokens live in `tokens.css`; styles in `src/renderer/src/styles/` (`global.css` primitives, `layout.css` shell, `components.css` surfaces).

## Tokens

- **Surfaces:** graphite with a slight warm cast (oklch hue 67), darkest to lightest: `bg-deep` 17.5% (app bar, rail, status bar), `bg` 20% (chat), `surface` 23% (cards, inputs), `surface-raised` 25.5% (popovers, dialogs), `hover` 28.5%.
- **Lines and fills:** translucent ink (5.5%, 8.5% and 14% alpha), so they read the same on every layer.
- **Text:** ink 93%, muted 70%, faint 62%. Body text clears 4.5:1 on every surface.
- **Accent:** one amber/copper, `oklch(78% 0.13 70)`, for primary actions, focus, live state and progress. Dark ink sits on accent fills.
- **Semantic colours:** muted success, warning, danger and info, each with a wash and a line variant.
- **Provider swatches:** 8px marks so the active model reads at a glance. Anthropic is clay, OpenAI and OpenAI Codex teal, Command Code blue, OpenCode Zen violet, Apple grey; unknown providers get a neutral outline.
- **Type:** SF Pro Text 13px for the UI, SF Mono 12px for code, ids, paths and costs. Headings stay modest (22/16/14).
- **Shape:** 6px controls, 10px cards and dialogs, pills for chips. Spacing steps are 2, 4, 6, 8, 12, 16, 20, 24 and 32.
- **Motion:** 120–180ms ease-out on opacity, transform and colour. The rail and workbench slide by animating grid columns. Both the OS reduce-motion setting and Settings → Reduce motion turn all of this off.

## Layout

Window: `hiddenInset` title bar, with the traffic lights at 16/15 and the app bar padded 78px on the left. Rows are the 40px app bar, the workspace, and a 24px status bar. The workspace has three columns: the plan rail (272px), the chat (fluid, transcript capped at 820px), and the workbench (`clamp(360px, 32vw, 440px)`). ⌘1 and ⌘2 collapse the side columns.

## Rules

- omp is the voice of the transcript. Assistant turns have no bubble and are labelled with the model that produced them; user turns are right-aligned bubbles.
- Tool calls collapse to one line (status icon, tool name, the agent's stated intent) and expand to show arguments and output.
- Approval prompts are modal and focus Deny. Return approves only after a short arming delay, so a keystroke meant for the composer cannot approve a command.
- Costs, context use and model identity are always visible for the active tab. Nothing about autonomous execution is hidden.
- No gradients, glows, serif display type or decorative illustration.
