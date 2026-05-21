import type { StateCreator } from 'zustand';
import type { ConversationSession, ConversationSpeaker, ConversationTurn } from '../utils/conversationSession';
import {
  createConversationSession,
  updateSpeakerMemory,
} from '../utils/conversationSession';

export interface ConversationSlice {
  activeConversationId: string;
  conversationArchive: ConversationSession[];
  conversationSpeakers: ConversationSpeaker[];
  conversationTurns: ConversationTurn[];

  startNewConversation: (title?: string, speakers?: ConversationSpeaker[]) => void;
  openConversation: (conversationId: string) => void;
  renameConversation: (conversationId: string, title: string) => void;
  deleteConversation: (conversationId: string) => void;
  setConversationSpeakers: (speakers: ConversationSpeaker[]) => void;
  updateConversationSpeaker: (speakerId: string, patch: Partial<Omit<ConversationSpeaker, 'id'>>) => void;
  setConversationTurns: (turns: ConversationTurn[]) => void;
  addConversationTurn: (turn: ConversationTurn) => void;
}

const initialConversation = createConversationSession({
  id: 'conversation-default',
  title: 'Conversation 1',
  createdAt: 0,
});

function upsertConversation(
  archive: ConversationSession[],
  activeConversationId: string,
  patch: Partial<ConversationSession>,
): ConversationSession[] {
  const now = Date.now();
  return archive.map(conversation => (
    conversation.id === activeConversationId
      ? { ...conversation, ...patch, updatedAt: now }
      : conversation
  ));
}

export const createConversationSlice: StateCreator<ConversationSlice, [], [], ConversationSlice> = (set, get) => ({
  activeConversationId: initialConversation.id,
  conversationArchive: [initialConversation],
  conversationSpeakers: initialConversation.speakers,
  conversationTurns: [],

  startNewConversation: (title = '', speakers) => set((s) => {
    const now = Date.now();
    const next = createConversationSession({
      id: `conversation-${now}`,
      title: title.trim() || `Conversation ${s.conversationArchive.length + 1}`,
      speakers: speakers || s.conversationSpeakers,
      createdAt: now,
    });
    return {
      activeConversationId: next.id,
      conversationArchive: [next, ...s.conversationArchive],
      conversationSpeakers: next.speakers,
      conversationTurns: [],
    };
  }),

  openConversation: (conversationId) => set((s) => {
    const match = s.conversationArchive.find(conversation => conversation.id === conversationId);
    if (!match) return {};
    return {
      activeConversationId: match.id,
      conversationSpeakers: match.speakers,
      conversationTurns: match.turns,
    };
  }),

  renameConversation: (conversationId, title) => set((s) => {
    const trimmed = title.trim();
    if (!trimmed) return {};
    return {
      conversationArchive: s.conversationArchive.map(conversation => (
        conversation.id === conversationId
          ? { ...conversation, title: trimmed, updatedAt: Date.now() }
          : conversation
      )),
    };
  }),

  deleteConversation: (conversationId) => set((s) => {
    const remaining = s.conversationArchive.filter(conversation => conversation.id !== conversationId);
    const nextArchive = remaining.length ? remaining : [createConversationSession({ id: `conversation-${Date.now()}`, title: 'Conversation 1' })];
    const nextActive = s.activeConversationId === conversationId
      ? nextArchive[0]
      : nextArchive.find(conversation => conversation.id === s.activeConversationId) || nextArchive[0];
    return {
      activeConversationId: nextActive.id,
      conversationArchive: nextArchive,
      conversationSpeakers: nextActive.speakers,
      conversationTurns: nextActive.turns,
    };
  }),

  setConversationSpeakers: (speakers) => set((s) => ({
    conversationSpeakers: speakers,
    conversationArchive: upsertConversation(s.conversationArchive, s.activeConversationId, { speakers }),
  })),

  updateConversationSpeaker: (speakerId, patch) => {
    const next = updateSpeakerMemory(get().conversationSpeakers, speakerId, patch);
    get().setConversationSpeakers(next);
  },

  setConversationTurns: (turns) => set((s) => ({
    conversationTurns: turns,
    conversationArchive: upsertConversation(s.conversationArchive, s.activeConversationId, { turns }),
  })),

  addConversationTurn: (turn) => {
    const turns = [...get().conversationTurns, turn];
    get().setConversationTurns(turns);
  },
});
