# Quick Task 260521-l1a Summary

## Result

Conversation speaker profile cards now move so the active speaker is first.

## Implementation Notes

- Added `orderConversationSpeakersByActive` as a pure visual-order helper.
- Wired `ConversationTab` to render speaker profile cards with the active
  speaker first.
- Left the stored `conversationSpeakers` array untouched so speaker memory,
  export selection, and archive persistence stay stable.
- Added a regression test proving the helper moves the selected speaker first
  without mutating the original speaker memory.

## Verification

- Red check: `bun run test:frontend` failed with
  `orderConversationSpeakersByActive is not a function`.
- Green check: `bun run test:frontend` passed: 90 tests.
- Playwright mobile check passed: clicking Speaker 2 moved Speaker 2's profile
  card above Speaker 1, and clicking Speaker 1 moved Speaker 1 back.
- `bun run --cwd frontend test` passed: 3 files, 24 tests.
- `bun run --cwd frontend typecheck:ci` passed.
- `bun run --cwd frontend build` passed.
