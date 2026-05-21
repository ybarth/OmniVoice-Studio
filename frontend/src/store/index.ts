/**
 * Zustand store root — Phase 2.2 (ROADMAP.md).
 *
 * Goal: peel state off the 1,803-line App.jsx monolith a slice at a time,
 * without big-bang disruption. Every slice lives in its own file, and the
 * root store composes them.
 *
 * Rule of thumb:
 *   - UI primitives own their local state (don't lift it).
 *   - App-level state (active project, user prefs, pipeline progress) lives
 *     here.
 *   - Selectors live at call sites (`useStore(s => s.foo)`).
 *
 * localStorage persistence uses zustand's own middleware so reloads keep
 * your quality/dual-subs/glossary-visibility choice.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import type { PrefsSlice } from './prefsSlice';
import { createPrefsSlice } from './prefsSlice';
import type { GlossarySlice } from './glossarySlice';
import { createGlossarySlice } from './glossarySlice';
import type { UiSlice } from './uiSlice';
import { createUiSlice } from './uiSlice';
import type { DubSlice } from './dubSlice';
import { createDubSlice } from './dubSlice';
import type { GenerateSlice } from './generateSlice';
import { createGenerateSlice } from './generateSlice';
import type { PillSlice } from './pillSlice';
import { createPillSlice } from './pillSlice';
import type { ConversationSlice } from './conversationSlice';
import { createConversationSlice } from './conversationSlice';
import type { ConversationTurn } from '../utils/conversationSession';

export type AppStore = PrefsSlice & GlossarySlice & UiSlice & DubSlice & GenerateSlice & PillSlice & ConversationSlice;

function stripVolatileConversationAudio(turns: ConversationTurn[] = []): ConversationTurn[] {
  return turns.map(turn => ({
    ...turn,
    sourceAudioUrl: turn.sourceAudioUrl?.startsWith?.('blob:') ? '' : turn.sourceAudioUrl,
  }));
}

/**
 * `useAppStore` — single root store. Don't create siblings. Slices compose here.
 *
 * Usage:
 *   const quality = useAppStore(s => s.translateQuality);
 *   const setQuality = useAppStore(s => s.setTranslateQuality);
 */
export const useAppStore = create<AppStore>()(
  persist(
    (set, get, api) => ({
      ...createPrefsSlice(set, get, api),
      ...createGlossarySlice(set, get, api),
      ...createUiSlice(set, get, api),
      ...createDubSlice(set, get, api),
      ...createGenerateSlice(set, get, api),
      ...createPillSlice(set, get, api),
      ...createConversationSlice(set, get, api),
    }),
    {
      name: 'omnivoice.app',
      storage: createJSONStorage(() => localStorage),
      // Only persist user prefs + glossary. Pipeline / transient state is opt-out.
      partialize: (s) => ({
        translateQuality:           s.translateQuality,
        cloneTranslateProvider:     s.cloneTranslateProvider,
        dualSubs:                   s.dualSubs,
        burnSubs:                   s.burnSubs,
        glossaryVisible:            s.glossaryVisible,
        reviewMode:                 s.reviewMode,
        mode:                       s.mode,
        isSidebarCollapsed:         s.isSidebarCollapsed,
        isSidebarProjectsCollapsed: s.isSidebarProjectsCollapsed,
        sidebarTab:                 s.sidebarTab,
        uiScale:                    s.uiScale,
        theme:                      s.theme,
        activeConversationId:       s.activeConversationId,
        conversationArchive:        s.conversationArchive.map(conversation => ({
          ...conversation,
          turns: stripVolatileConversationAudio(conversation.turns),
        })),
        conversationSpeakers:       s.conversationSpeakers,
        conversationTurns:          stripVolatileConversationAudio(s.conversationTurns),
        // Generate-tab prefs — users expect their synthesis knobs to stick.
        language:      s.language,
        speed:         s.speed,
        steps:         s.steps,
        cfg:           s.cfg,
        tShift:        s.tShift,
        posTemp:       s.posTemp,
        classTemp:     s.classTemp,
        layerPenalty:  s.layerPenalty,
        denoise:       s.denoise,
        postprocess:   s.postprocess,
        vdStates:      s.vdStates,
      }),
      version: 5,
      // Drop old persisted shapes rather than crashing the app. Every field
      // has a safe default in its slice, so v1/v2 users pick up v3 defaults
      // for the new fields (mode, uiScale, generate knobs, etc.) and keep
      // any keys we still write today. Upgrade > crash.
      migrate: (persisted, version) => {
        if (!persisted || typeof persisted !== 'object') return {} as Partial<AppStore>;
        if (version < 5) {
          // v1 → v2 added reviewMode; v2 → v3 added mode/sidebar/generate knobs.
          // v4/v5 added conversation state. All of those have slice defaults, so passing through the old keys
          // is sufficient — anything missing falls through to the slice init.
          return persisted as Partial<AppStore>;
        }
        return persisted as Partial<AppStore>;
      },
    },
  ),
);
