---
phase: quick-260521-kpf
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - frontend/src/index.css
  - frontend/src/pages/ConversationTab.css
  - frontend/src/pages/Projects.css
  - frontend/src/pages/Projects.jsx
autonomous: true
requirements:
  - Clean up the mobile interface so text and controls do not overlap.
  - Keep Conversation as the central/default surface.
  - Verify the retained tabs on narrow phone widths.
---

<objective>
Make the focused Vox Tower mobile layout neat and usable on phone widths,
especially the Conversation default surface.
</objective>

<design>
Add a dedicated phone layout for Conversation instead of relying on desktop
grids to squeeze down. Stack the composer above speaker setup, make archive
controls and action groups single-column where needed, and constrain labels so
buttons do not resize or collide. Tune the shared mobile rail for five tabs at
320px. While sweeping retained tabs, fix Drive's missing icon import and give
Drive a phone-specific filter/content layout.
</design>

<verify>
- Playwright iPhone-width sweep at 320, 375, 390, and 430px for Conversation.
- Playwright retained-tab sweep at 320 and 390px for Conversation, Clone,
  Design, Drive, and Settings.
- `bun run --cwd frontend test`
- `bun run test:frontend`
- `bun run --cwd frontend typecheck:ci`
- `bun run --cwd frontend build`
</verify>
