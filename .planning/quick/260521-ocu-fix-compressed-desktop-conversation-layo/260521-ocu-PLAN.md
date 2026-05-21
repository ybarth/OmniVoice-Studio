# Quick Plan: Fix compressed desktop conversation layout

## Debug Notes

- Reproduce the remote desktop compression with realistic desktop viewport sizes.
- Trace shell height, tab chrome, conversation grid, speaker card, and timeline sizing.
- Add a small regression test for the viewport scale calculation if the root cause is computed sizing.

## Scope

- Preserve the existing top/default conversation tab and bottom/mobile tab structure.
- Fix desktop layout so conversation turns remain visible and profile/speaker names do not get crushed.
- Avoid broad redesign or navigation changes.

## Verification

- Frontend unit tests.
- Production build.
- Browser smoke checks at desktop and mobile viewport sizes.
