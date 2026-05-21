# 260521-mkh Summary: Restore Mobile Bottom Tabs and Anchor Logs Footer

## Result

- Restored the mobile bottom tabs as explicit fixed phone chrome.
- Fixed the desktop logs/scale footer anchoring issue caused by UI-scale zoom making the app shell taller than the viewport.

## Root Cause

The `.vox-shell` receives the effective UI scale through CSS `zoom`. At desktop `M` scale (`1.3`), the shell height was computed first and then physically scaled taller than the viewport. That made the document scroll behind the fixed footer, so the footer did not behave like stable bottom chrome.

On mobile, the nav rail was being restored by a later branding override after an older small-screen rule hid it. The browser geometry showed it could render, but the cascade was too fragile for the bottom tab bar.

## Fix

- Added `--app-ui-scale` to the shell inline style.
- Updated the Vox shell height formula to compensate for the UI scale: the shell's physical bottom now meets the logs footer's top.
- Explicitly set the mobile nav rail to `display: flex !important` and raised its z-index so the tabs remain visible above the footer layer.

## Verification

- Confirmed the pre-fix desktop geometry failed with a `1134px` document in a `900px` viewport.
- Confirmed post-fix collapsed desktop footer geometry:
  - document height stays within the viewport
  - shell bottom meets footer top
  - footer bottom stays at viewport bottom
- Confirmed post-fix expanded desktop footer geometry with the same anchoring behavior.
- Confirmed mobile bottom tabs at `375`, `390`, and `430` px widths:
  - nav display is `flex`
  - nav position is `fixed`
  - nav sits directly above the logs footer
- Ran `bun run test:frontend` successfully.
- Ran `bun run --cwd frontend test` successfully.
- Ran `bun run --cwd frontend typecheck:ci` successfully.
- Ran `bun run --cwd frontend build` successfully.
- Confirmed the public Cloudflare preview returned `HTTP/2 200`.
