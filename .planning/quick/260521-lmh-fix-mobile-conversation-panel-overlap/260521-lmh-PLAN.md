# 260521-lmh Plan: Fix Mobile Conversation Panel Overlap

## Problem

On an iPhone-width viewport, the Conversation tab detects mobile mode correctly, but the visible panels overlap. The speakers panel content overflows beyond its shrunk container while the timeline/export panel starts too early.

## Root Cause

The mobile Conversation tab is still a flex column inside a viewport-height main area. Its child panels use default flex shrinking, and the timeline keeps the desktop `flex: 1` behavior. On mobile, this lets the grid and timeline shrink below their content height, so overflow from the speaker panel paints under later panels.

## Fix

- In the mobile breakpoint, make the Conversation tab, grid, panels, and timeline participate as content-sized vertical blocks.
- Preserve scrolling on the main content container rather than forcing inner panels to shrink.
- Keep the existing mobile ordering where the active turn composer appears before speaker settings.

## Verification

- Re-run the iPhone Playwright geometry check: the timeline must start after the speaker panel.
- Capture a mobile screenshot for visual inspection.
- Run frontend tests/build checks.
