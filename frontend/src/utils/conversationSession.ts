export type ConversationVoiceProfile = {
  id: string;
  name?: string;
  ref_text?: string;
};

export type ConversationSpeaker = {
  id: string;
  name: string;
  sourceLanguage: string;
  targetLanguage: string;
  voiceProfileId: string;
  translationProvider: string;
  style: string;
  referenceTranscript: string;
  color: string;
};

export type ConversationTurn = {
  id: string;
  speakerId: string;
  speakerName: string;
  sourceText: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  voiceProfileId: string;
  translationProvider: string;
  style: string;
  audioUrl: string;
  audioId: string;
  audioPath: string;
  sourceAudioUrl: string;
  sourceAudioName: string;
  sourceAudioTranscriptEngine: string;
  createdAt: number;
};

export type ConversationSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  speakers: ConversationSpeaker[];
  turns: ConversationTurn[];
};

export type ConversationExportScope = 'all' | 'selected' | 'range' | 'speakers';

export type ConversationExportSelectionOptions = {
  scope: ConversationExportScope;
  selectedTurnIds?: string[];
  rangeStart?: number;
  rangeEnd?: number;
  speakerIds?: string[];
};

const SPEAKER_COLORS = ['#d3869b', '#8ec07c', '#83a598', '#fabd2f', '#fe8019', '#b8bb26', '#a89984', '#fb4934'];

export const DEFAULT_CONVERSATION_SPEAKERS: ConversationSpeaker[] = [
  {
    id: 'speaker-a',
    name: 'Speaker 1',
    sourceLanguage: 'English',
    targetLanguage: 'Cantonese',
    voiceProfileId: '',
    translationProvider: 'hymt-1.8b',
    style: '',
    referenceTranscript: '',
    color: '#d3869b',
  },
  {
    id: 'speaker-b',
    name: 'Speaker 2',
    sourceLanguage: 'Cantonese',
    targetLanguage: 'English',
    voiceProfileId: '',
    translationProvider: 'hymt-1.8b',
    style: '',
    referenceTranscript: '',
    color: '#8ec07c',
  },
];

function cloneSpeaker(speaker: ConversationSpeaker): ConversationSpeaker {
  return { ...speaker };
}

export function createDefaultSpeakers(
  profiles: ConversationVoiceProfile[] = [],
  translationProvider = 'hymt-1.8b',
): ConversationSpeaker[] {
  return DEFAULT_CONVERSATION_SPEAKERS.map((speaker, index) => ({
    ...cloneSpeaker(speaker),
    translationProvider,
    voiceProfileId: profiles[index]?.id || '',
    referenceTranscript: profiles[index]?.ref_text || '',
  }));
}

export function nextSpeakerNumber(speakers: ConversationSpeaker[]): number {
  const used = new Set(
    speakers
      .map(speaker => speaker.name.match(/^Speaker\s+(\d+)$/i)?.[1])
      .filter(Boolean)
      .map(value => Number(value)),
  );
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

export function addConversationSpeaker(
  speakers: ConversationSpeaker[],
  profiles: ConversationVoiceProfile[] = [],
  translationProvider = 'hymt-1.8b',
): ConversationSpeaker[] {
  const number = nextSpeakerNumber(speakers);
  const profile = profiles[number - 1];
  return [
    ...speakers,
    {
      id: `speaker-${number}`,
      name: `Speaker ${number}`,
      sourceLanguage: speakers[0]?.sourceLanguage || 'English',
      targetLanguage: speakers[0]?.targetLanguage || 'Cantonese',
      voiceProfileId: profile?.id || '',
      translationProvider,
      style: '',
      referenceTranscript: profile?.ref_text || '',
      color: SPEAKER_COLORS[(number - 1) % SPEAKER_COLORS.length],
    },
  ];
}

export function updateSpeakerMemory(
  speakers: ConversationSpeaker[],
  speakerId: string,
  patch: Partial<Omit<ConversationSpeaker, 'id'>>,
): ConversationSpeaker[] {
  return speakers.map(speaker => (
    speaker.id === speakerId
      ? { ...speaker, ...patch }
      : speaker
  ));
}

export function orderConversationSpeakersByActive(
  speakers: ConversationSpeaker[],
  activeSpeakerId: string,
): ConversationSpeaker[] {
  const active = speakers.find(speaker => speaker.id === activeSpeakerId);
  if (!active) return speakers.slice();
  return [
    active,
    ...speakers.filter(speaker => speaker.id !== activeSpeakerId),
  ];
}

export function speakerDefaultsForTurn(
  speakers: ConversationSpeaker[],
  speakerId: string,
): ConversationSpeaker {
  const match = speakers.find(speaker => speaker.id === speakerId)
    || speakers[0]
    || DEFAULT_CONVERSATION_SPEAKERS[0];
  return cloneSpeaker(match);
}

export function createConversationTurn({
  speaker,
  sourceText,
  translatedText,
  audioUrl = '',
  audioId = '',
  audioPath = '',
  sourceAudioUrl = '',
  sourceAudioName = '',
  sourceAudioTranscriptEngine = '',
  createdAt = Date.now(),
}: {
  speaker: ConversationSpeaker;
  sourceText: string;
  translatedText: string;
  audioUrl?: string;
  audioId?: string;
  audioPath?: string;
  sourceAudioUrl?: string;
  sourceAudioName?: string;
  sourceAudioTranscriptEngine?: string;
  createdAt?: number;
}): ConversationTurn {
  return {
    id: `turn-${createdAt}-${speaker.id}`,
    speakerId: speaker.id,
    speakerName: speaker.name,
    sourceText,
    translatedText,
    sourceLanguage: speaker.sourceLanguage,
    targetLanguage: speaker.targetLanguage,
    voiceProfileId: speaker.voiceProfileId,
    translationProvider: speaker.translationProvider,
    style: speaker.style,
    audioUrl,
    audioId,
    audioPath,
    sourceAudioUrl,
    sourceAudioName,
    sourceAudioTranscriptEngine,
    createdAt,
  };
}

export function createConversationSession({
  id = `conversation-${Date.now()}`,
  title = 'Conversation',
  speakers = DEFAULT_CONVERSATION_SPEAKERS,
  turns = [],
  createdAt = Date.now(),
}: {
  id?: string;
  title?: string;
  speakers?: ConversationSpeaker[];
  turns?: ConversationTurn[];
  createdAt?: number;
} = {}): ConversationSession {
  return {
    id,
    title,
    speakers: speakers.map(cloneSpeaker),
    turns: turns.map(turn => ({ ...turn })),
    createdAt,
    updatedAt: createdAt,
  };
}

export function buildConversationExportSelection(
  turns: ConversationTurn[],
  {
    scope,
    selectedTurnIds = [],
    rangeStart = 1,
    rangeEnd = turns.length,
    speakerIds = [],
  }: ConversationExportSelectionOptions,
): ConversationTurn[] {
  if (scope === 'selected') {
    const selected = new Set(selectedTurnIds);
    return turns.filter(turn => selected.has(turn.id));
  }
  if (scope === 'range') {
    const start = Math.max(1, Math.min(rangeStart || 1, rangeEnd || turns.length));
    const end = Math.max(start, rangeEnd || turns.length);
    return turns.filter((_, index) => index + 1 >= start && index + 1 <= end);
  }
  if (scope === 'speakers') {
    const selected = new Set(speakerIds);
    if (!selected.size) return [];
    return turns.filter(turn => selected.has(turn.speakerId));
  }
  return turns.slice();
}
