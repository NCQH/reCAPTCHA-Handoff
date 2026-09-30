import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createScreencastStream,
  findPlaywrightHeadlessShell,
  findSystemBrowser,
  isValidInputEvent,
  playwrightCacheDir,
  redactProxyForLog,
  VIEWPORT
} from '../src/browser.js';

function fakeCdp() {
  const listeners = new Map();
  const sent = [];

  return {
    sent,
    on(method, listener) {
      listeners.set(method, listener);
    },
    off(method, listener) {
      if (listeners.get(method) === listener) listeners.delete(method);
    },
    async send(method, params) {
      sent.push({ method, params });
    },
    async emit(method, payload) {
      return listeners.get(method)?.(payload);
    },
    hasListener(method) {
      return listeners.has(method);
    }
  };
}

test('screencast forwards frame data and acknowledges the CDP session', async () => {
  const cdp = fakeCdp();
  const frames = [];
  const stream = createScreencastStream(cdp, {
    viewport: VIEWPORT,
    emitFrame: (data) => frames.push(data)
  });

  await stream.start();
  await cdp.emit('Page.screencastFrame', { data: 'jpeg-base64', sessionId: 42 });

  assert.deepEqual(frames, ['jpeg-base64']);
  assert.deepEqual(cdp.sent, [
    {
      method: 'Page.startScreencast',
      params: {
        format: 'jpeg',
        quality: 90,
        maxWidth: VIEWPORT.width,
        maxHeight: VIEWPORT.height
      }
    },
    {
      method: 'Page.screencastFrameAck',
      params: { sessionId: 42 }
    }
  ]);
});

test('stopping a screencast stops CDP and removes its frame listener', async () => {
  const cdp = fakeCdp();
  const stream = createScreencastStream(cdp, { emitFrame: () => {} });

  await stream.start();
  await stream.stop();

  assert.equal(cdp.hasListener('Page.screencastFrame'), false);
  assert.equal(cdp.sent.at(-1).method, 'Page.stopScreencast');
});

test('input validation accepts normalized mouse events and rejects malformed values', () => {
  assert.equal(isValidInputEvent({ type: 'input', kind: 'move', nx: 0.5, ny: 0 }), true);
  assert.equal(isValidInputEvent({ type: 'input', kind: 'wheel', nx: 1, ny: 1, dx: 0, dy: -120 }), true);
  assert.equal(isValidInputEvent(null), false);
  assert.equal(isValidInputEvent({ type: 'input', kind: 'move', nx: 2, ny: 0 }), false);
  assert.equal(isValidInputEvent({ type: 'input', kind: 'move', nx: Infinity, ny: 0 }), false);
  assert.equal(isValidInputEvent({ type: 'input', kind: 'script', nx: 0, ny: 0 }), false);
  assert.equal(isValidInputEvent({ type: 'input', kind: 'wheel', nx: 0, ny: 0, dx: 0, dy: 5001 }), false);
});

test('proxy log formatting never exposes proxy credentials', () => {
  assert.equal(redactProxyForLog('http://alice:secret@example.test:8080'), 'http://***:***@example.test:8080');
  assert.equal(redactProxyForLog('socks5://proxy.example.test:1080'), 'socks5://proxy.example.test:1080');
  assert.equal(redactProxyForLog('not a url'), '[configured]');
  assert.equal(redactProxyForLog(''), 'none');
});

function fakeFs(files, dirs = {}) {
  const existing = new Set(files);
  return {
    existsSync: (file) => existing.has(file),
    readdirSync: (dir) => (dirs[dir] || []).map((name) => ({ name, isDirectory: () => true }))
  };
}

test('system browser discovery prefers Chrome, then Edge, on Linux', () => {
  const env = { HOME: '/home/u' };
  assert.equal(
    findSystemBrowser({ platform: 'linux', env, fsImpl: fakeFs(['/usr/bin/microsoft-edge', '/usr/bin/google-chrome']) }),
    '/usr/bin/google-chrome'
  );
  assert.equal(
    findSystemBrowser({ platform: 'linux', env, fsImpl: fakeFs(['/usr/bin/microsoft-edge']) }),
    '/usr/bin/microsoft-edge'
  );
  assert.equal(findSystemBrowser({ platform: 'linux', env, fsImpl: fakeFs([]) }), '');
});

test('system browser discovery keeps Windows install paths', () => {
  const env = { PROGRAMFILES: 'C:\\Program Files' };
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert.equal(findSystemBrowser({ platform: 'win32', env, fsImpl: fakeFs([chrome]) }), chrome);
});

test('playwright cache dir follows platform conventions and overrides', () => {
  assert.equal(playwrightCacheDir({ platform: 'linux', env: { HOME: '/home/u' } }), '/home/u/.cache/ms-playwright');
  assert.equal(playwrightCacheDir({ platform: 'linux', env: { HOME: '/home/u', XDG_CACHE_HOME: '/xdg' } }), '/xdg/ms-playwright');
  assert.equal(playwrightCacheDir({ platform: 'linux', env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' } }), '/pw');
  assert.equal(playwrightCacheDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' } }), 'C:\\L\\ms-playwright');
});

test('headless shell discovery picks the newest complete Linux install', () => {
  const root = '/home/u/.cache/ms-playwright';
  const fsImpl = fakeFs(
    [
      `${root}/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell`,
      `${root}/chromium_headless_shell-1200/INSTALLATION_COMPLETE`,
      `${root}/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`,
      `${root}/chromium_headless_shell-1234/INSTALLATION_COMPLETE`,
      `${root}/chromium_headless_shell-1300/chrome-headless-shell-linux64/chrome-headless-shell`
    ],
    { [root]: ['chromium_headless_shell-1200', 'chromium_headless_shell-1234', 'chromium_headless_shell-1300', 'ffmpeg-1011'] }
  );
  assert.equal(
    findPlaywrightHeadlessShell({ platform: 'linux', env: { HOME: '/home/u' }, fsImpl }),
    `${root}/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`
  );
});
