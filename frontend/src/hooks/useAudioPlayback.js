import { useCallback, useEffect, useRef, useState } from 'react';

const EMPTY_PLAYBACK = {
  key: '',
  status: 'idle',
  source: '',
  label: '',
};

function clearAudioElement(audio) {
  if (!audio) return;
  audio.onplay = null;
  audio.onpause = null;
  audio.onended = null;
  audio.onerror = null;
  audio.pause();
  audio.removeAttribute('src');
  audio.load?.();
}

export default function useAudioPlayback() {
  const audioRef = useRef(null);
  const ownedUrlRef = useRef('');
  const [playback, setPlayback] = useState(EMPTY_PLAYBACK);

  const revokeOwnedUrl = useCallback(() => {
    if (!ownedUrlRef.current) return;
    URL.revokeObjectURL(ownedUrlRef.current);
    ownedUrlRef.current = '';
  }, []);

  const stop = useCallback(() => {
    clearAudioElement(audioRef.current);
    audioRef.current = null;
    revokeOwnedUrl();
    setPlayback(EMPTY_PLAYBACK);
  }, [revokeOwnedUrl]);

  const playSource = useCallback(async ({ key, url = '', blob = null, label = '' }) => {
    if (!key) throw new Error('Audio playback needs a stable key');
    if (!url && !blob) throw new Error('Audio playback needs a URL or blob');

    clearAudioElement(audioRef.current);
    audioRef.current = null;
    revokeOwnedUrl();

    const source = blob ? URL.createObjectURL(blob) : url;
    if (blob) ownedUrlRef.current = source;

    const audio = new Audio(source);
    audioRef.current = audio;
    setPlayback({ key, status: 'loading', source, label });

    audio.onplay = () => {
      setPlayback(prev => (prev.key === key ? { ...prev, status: 'playing' } : prev));
    };
    audio.onpause = () => {
      setPlayback(prev => (
        prev.key === key && !audio.ended ? { ...prev, status: 'paused' } : prev
      ));
    };
    audio.onended = () => {
      setPlayback(prev => (prev.key === key ? { ...prev, status: 'ended' } : prev));
    };
    audio.onerror = () => {
      setPlayback(prev => (prev.key === key ? { ...prev, status: 'error' } : prev));
    };

    try {
      await audio.play();
    } catch (error) {
      setPlayback(prev => (prev.key === key ? { ...prev, status: 'error' } : prev));
      throw error;
    }
  }, [revokeOwnedUrl]);

  const pause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || audio.paused || audio.ended) return;
    audio.pause();
  }, []);

  const resume = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) throw new Error('No audio is ready to resume');
    if (audio.ended) audio.currentTime = 0;
    setPlayback(prev => (prev.key ? { ...prev, status: 'loading' } : prev));
    await audio.play();
  }, []);

  const toggleCurrent = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused && !audio.ended) {
      pause();
      return;
    }
    await resume();
  }, [pause, resume]);

  const toggleSource = useCallback(async ({ key, url = '', blob = null, label = '' }) => {
    const audio = audioRef.current;
    if (audio && playback.key === key) {
      if (!audio.paused && !audio.ended) {
        pause();
        return;
      }
      await resume();
      return;
    }
    await playSource({ key, url, blob, label });
  }, [pause, playback.key, playSource, resume]);

  useEffect(() => () => {
    clearAudioElement(audioRef.current);
    audioRef.current = null;
    revokeOwnedUrl();
  }, [revokeOwnedUrl]);

  return {
    playback,
    playSource,
    pause,
    resume,
    toggleCurrent,
    toggleSource,
    stop,
  };
}
