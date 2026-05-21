import { test } from 'node:test';
import assert from 'node:assert/strict';

const modulePath = new URL('../../frontend/src/utils/deviceProfile.ts', import.meta.url).pathname;
const { deviceClassNames, getDeviceProfile } = await import(modulePath);

function fakeWindow({ width = 390, height = 844, coarse = true, pixelRatio = 3 } = {}) {
  return {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: pixelRatio,
    matchMedia: query => ({ matches: query === '(pointer: coarse)' ? coarse : false }),
  };
}

test('getDeviceProfile detects iPhone Safari as phone/iOS', () => {
  const nav = {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    platform: 'iPhone',
    maxTouchPoints: 5,
  };

  const profile = getDeviceProfile(nav, fakeWindow());

  assert.equal(profile.kind, 'phone');
  assert.equal(profile.os, 'ios');
  assert.equal(profile.isIPhone, true);
  assert.equal(profile.isIOS, true);
  assert.equal(profile.orientation, 'portrait');
  assert.ok(deviceClassNames(profile).includes('device-iphone'));
});

test('getDeviceProfile treats touch MacIntel iPad reports as iPad tablet', () => {
  const nav = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  };

  const profile = getDeviceProfile(nav, fakeWindow({ width: 1024, height: 768 }));

  assert.equal(profile.kind, 'tablet');
  assert.equal(profile.os, 'ios');
  assert.equal(profile.isIPad, true);
  assert.ok(deviceClassNames(profile).includes('device-ipad'));
});

test('getDeviceProfile keeps desktop Mac as desktop', () => {
  const nav = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5) AppleWebKit/605.1.15 Safari/605.1.15',
    platform: 'MacIntel',
    maxTouchPoints: 0,
  };

  const profile = getDeviceProfile(nav, fakeWindow({ width: 1440, height: 920, coarse: false, pixelRatio: 2 }));

  assert.equal(profile.kind, 'desktop');
  assert.equal(profile.os, 'macos');
  assert.equal(profile.isIPhone, false);
  assert.equal(profile.isTouch, false);
});
