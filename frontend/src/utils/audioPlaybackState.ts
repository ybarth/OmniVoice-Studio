export type AudioPlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export type PlaybackControlAction = 'play' | 'pause' | 'resume' | 'none';

export type PlaybackControlView = {
  visible: boolean;
  disabled: boolean;
  label: string;
  title: string;
  action: PlaybackControlAction;
  icon: 'play' | 'pause';
};

export function playbackControlFor({
  activeKey = '',
  key = '',
  status = 'idle',
  hasAudio = false,
}: {
  activeKey?: string;
  key?: string;
  status?: AudioPlaybackStatus;
  hasAudio?: boolean;
}): PlaybackControlView {
  if (!hasAudio) {
    return {
      visible: false,
      disabled: true,
      label: 'Play',
      title: 'No audio available',
      action: 'none',
      icon: 'play',
    };
  }

  const isActive = Boolean(key && activeKey === key);

  if (isActive && status === 'playing') {
    return {
      visible: true,
      disabled: false,
      label: 'Pause',
      title: 'Pause playback',
      action: 'pause',
      icon: 'pause',
    };
  }

  if (isActive && status === 'paused') {
    return {
      visible: true,
      disabled: false,
      label: 'Resume',
      title: 'Resume playback',
      action: 'resume',
      icon: 'play',
    };
  }

  if (isActive && status === 'loading') {
    return {
      visible: true,
      disabled: true,
      label: 'Loading',
      title: 'Preparing playback',
      action: 'none',
      icon: 'play',
    };
  }

  return {
    visible: true,
    disabled: false,
    label: isActive && status === 'ended' ? 'Replay' : 'Play',
    title: isActive && status === 'ended' ? 'Replay audio' : 'Play audio',
    action: 'play',
    icon: 'play',
  };
}
