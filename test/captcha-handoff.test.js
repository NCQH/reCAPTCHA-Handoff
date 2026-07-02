import test from 'node:test';
import assert from 'node:assert/strict';

import {
  focusKey,
  getCaptchaFocusRect,
  waitForCaptchaToken
} from '../src/captcha-handoff.js';

const target = {
  anchorIframe: 'iframe.anchor',
  challengeIframe: 'iframe.challenge',
  tokenSelectors: 'textarea.token'
};

function fakeLocator(entry = {}) {
  return {
    async count() {
      return entry.count ?? (entry.visible ? 1 : 0);
    },
    first() {
      return this;
    },
    async isVisible() {
      return Boolean(entry.visible);
    },
    async boundingBox() {
      return entry.box ?? null;
    }
  };
}

function fakePage(entries) {
  return {
    locator(selector) {
      return fakeLocator(entries[selector]);
    },
    async $$eval(selector, fn) {
      return fn(entries[selector]?.elements ?? []);
    }
  };
}

test('focusKey returns a stable rounded key', () => {
  assert.equal(
    focusKey({ kind: 'checkbox', x: 10.4, y: 20.5, w: 304.2, h: 78.1 }),
    'checkbox:10,21,304,78'
  );
  assert.equal(focusKey(null), 'none');
});

test('getCaptchaFocusRect prefers a visible challenge frame', async () => {
  const page = fakePage({
    'iframe.challenge': {
      visible: true,
      box: { x: 50, y: 60, width: 420, height: 520 }
    },
    'iframe.anchor': {
      visible: true,
      box: { x: 10, y: 20, width: 304, height: 78 }
    }
  });

  assert.deepEqual(await getCaptchaFocusRect(page, target), {
    x: 50,
    y: 60,
    w: 420,
    h: 520,
    kind: 'challenge'
  });
});

test('getCaptchaFocusRect falls back to the checkbox frame', async () => {
  const page = fakePage({
    'iframe.challenge': { visible: false, count: 0 },
    'iframe.anchor': {
      visible: true,
      box: { x: 10, y: 20, width: 304, height: 78 }
    }
  });

  assert.deepEqual(await getCaptchaFocusRect(page, target), {
    x: 10,
    y: 20,
    w: 304,
    h: 78,
    kind: 'checkbox'
  });
});

test('getCaptchaFocusRect returns null when no frame is visible', async () => {
  const page = fakePage({
    'iframe.challenge': { visible: false, count: 0 },
    'iframe.anchor': { visible: false, count: 0 }
  });

  assert.equal(await getCaptchaFocusRect(page, target), null);
});

test('waitForCaptchaToken reads the first non-empty token', async () => {
  const page = fakePage({
    'textarea.token': {
      elements: [{ value: '' }, { value: 'captcha-token' }]
    }
  });

  const token = await waitForCaptchaToken(page, { target, timeoutMs: 10 });
  assert.equal(token, 'captcha-token');
});
