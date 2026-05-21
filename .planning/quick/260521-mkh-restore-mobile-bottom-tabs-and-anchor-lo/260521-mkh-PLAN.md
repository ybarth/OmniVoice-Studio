# 260521-mkh Plan: Restore Mobile Bottom Tabs and Anchor Logs Footer

## Problem

- On mobile, the bottom navigation tabs are not reliably visible as persistent bottom chrome.
- On desktop, the bottom logs/scale footer feels unanchored because the app shell becomes taller than the viewport at the default desktop UI scale.

## Root Cause

The app applies CSS `zoom` directly to the `.vox-shell` container. The container height is computed before the zoom is applied, so at the default `M` scale (`1.3`) the physical shell height exceeds the viewport. The document becomes scrollable behind the fixed logs footer.

The mobile nav rail is also still affected by an older small-screen rule that hides `.app-container > .nav-rail`; later Vox branding CSS restores it, but the override should be explicit for the phone chrome layer.

## Fix

- Expose the effective UI scale as a CSS variable on the shell.
- Compensate the Vox shell height for that scale so its physical bottom meets the logs footer top.
- Explicitly keep the phone nav rail displayed and above the rest of the mobile chrome.

## Verification

- Re-run the desktop geometry check: document height should stay within the viewport, and the shell bottom should meet the footer top.
- Re-run mobile geometry checks: nav rail should be visible and positioned directly above the logs footer.
- Run frontend tests, typecheck, and build.
