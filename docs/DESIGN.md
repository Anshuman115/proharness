# UI design

ProHarness uses a dark interface with dense controls and limited motion.

## Sources

- Use [design tokens](<../tokens.css>) for color, type, spacing, shape, and motion values.
- Use [global styles](<../src/renderer/src/styles/global.css>) for shared element styles.
- Use [layout styles](<../src/renderer/src/styles/layout.css>) for the app layout.
- Use [component styles](<../src/renderer/src/styles/components.css>) for UI components.

## Layout

The window contains an app bar, a workspace, and a status bar.
The workspace contains the plan rail, the chat panel, and the workbench.
The side panels can close to give the chat panel more space.

## Rules

- Use graphite backgrounds and one amber accent.
- Use the existing semantic colors for status and Git changes.
- Use system sans-serif type for controls.
- Use monospace type for code, paths, identifiers, and costs.
- Keep model identity, context use, and cost visible for the active tab.
- Show assistant turns with the model label and no message bubble.
- Align user message bubbles to the right.
- Show each tool call as one expandable row.
- Give approval dialogs initial focus on Deny.
- Preserve the approval delay before Return can approve a request.
- Obey the system and app settings for reduced motion.
- Keep gradients, glows, and decorative illustrations out of the interface.
