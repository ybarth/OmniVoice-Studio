# 260521-lmh Summary: Fix Mobile Conversation Panel Overlap

## Result

- Fixed the iPhone/mobile Conversation tab overlap shown in the screenshot.
- The Conversation mobile layout now lets the composer, speaker settings, and timeline/export panel stack as content-sized sections instead of shrinking into each other.

## Root Cause

The mobile breakpoint changed the Conversation grid into a flex column, but its children still inherited flex shrinking behavior. The timeline also kept the desktop `flex: 1` behavior. Inside the fixed viewport-height app shell, that compressed the grid and timeline below their content height, so the speaker panel overflow painted underneath the timeline/export controls.

## Fix

- Set the mobile Conversation tab/grid/timeline areas to `flex: 0 0 auto`.
- Reset mobile panel heights and min-heights to content-sized values.
- Let the main content viewport handle scrolling while the Conversation sections keep their natural vertical order.
- Kept the existing mobile order where the active turn composer appears before speaker settings.

## Verification

- Confirmed the pre-fix iPhone geometry failed: the timeline started at `774px` while the speaker panel extended to about `1835px`.
- Re-ran the iPhone geometry check after the fix at `375`, `390`, and `430` px widths; all passed with the timeline starting after the speaker panel.
- Captured `/private/tmp/vox-mobile-conversation-fixed.png` for visual inspection.
- Ran `bun run test:frontend` successfully.
- Ran `bun run --cwd frontend test` successfully.
- Ran `bun run --cwd frontend typecheck:ci` successfully.
- Ran `bun run --cwd frontend build` successfully.
