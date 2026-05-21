export type DeviceKind = 'phone' | 'tablet' | 'desktop';
export type DeviceOs = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'unknown';

export interface DeviceProfile {
  kind: DeviceKind;
  os: DeviceOs;
  isIPhone: boolean;
  isIPad: boolean;
  isIOS: boolean;
  isTouch: boolean;
  width: number;
  height: number;
  pixelRatio: number;
  orientation: 'portrait' | 'landscape';
}

function queryMedia(win: Window | undefined, query: string): boolean {
  try {
    return Boolean(win?.matchMedia?.(query).matches);
  } catch {
    return false;
  }
}

export function getDeviceProfile(
  nav: Navigator | undefined = globalThis.navigator,
  win: Window | undefined = globalThis.window,
): DeviceProfile {
  const ua = nav?.userAgent || '';
  const platform = nav?.platform || '';
  const maxTouchPoints = nav?.maxTouchPoints || 0;
  const width = Math.round(win?.innerWidth || 0);
  const height = Math.round(win?.innerHeight || 0);
  const coarsePointer = queryMedia(win, '(pointer: coarse)');
  const isTouch = maxTouchPoints > 0 || coarsePointer;

  const isIPhone = /iPhone|iPod/i.test(ua) || platform === 'iPhone';
  const isIPad = /iPad/i.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1 && isTouch);
  const isIOS = isIPhone || isIPad || /iPhone|iPad|iPod/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  const os: DeviceOs = isIOS
    ? 'ios'
    : isAndroid
      ? 'android'
      : /Mac/i.test(platform)
        ? 'macos'
        : /Win/i.test(platform)
          ? 'windows'
          : /Linux/i.test(platform)
            ? 'linux'
            : 'unknown';

  const narrow = width > 0 && width <= 680;
  const tabletWidth = width > 680 && width <= 1100;
  const kind: DeviceKind = isIPhone || (isTouch && narrow)
    ? 'phone'
    : (isIPad || (isTouch && tabletWidth))
      ? 'tablet'
      : 'desktop';

  return {
    kind,
    os,
    isIPhone,
    isIPad,
    isIOS,
    isTouch,
    width,
    height,
    pixelRatio: win?.devicePixelRatio || 1,
    orientation: height >= width ? 'portrait' : 'landscape',
  };
}

export function deviceClassNames(profile: DeviceProfile): string[] {
  return [
    `device-${profile.kind}`,
    `device-os-${profile.os}`,
    profile.isIPhone ? 'device-iphone' : '',
    profile.isIPad ? 'device-ipad' : '',
    profile.isTouch ? 'device-touch' : 'device-pointer',
    `device-${profile.orientation}`,
  ].filter(Boolean);
}

export function writeDeviceDataset(root: HTMLElement, profile: DeviceProfile): void {
  root.dataset.device = profile.kind;
  root.dataset.deviceOs = profile.os;
  root.dataset.iphone = profile.isIPhone ? 'true' : 'false';
  root.dataset.touch = profile.isTouch ? 'true' : 'false';
  root.dataset.orientation = profile.orientation;
}
