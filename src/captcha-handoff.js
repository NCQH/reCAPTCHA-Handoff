const DEFAULT_FOCUS_TIMEOUT_MS = 7000;
const DEFAULT_TOKEN_TIMEOUT_MS = 120_000;
const TOKEN_POLL_MS = 400;
const FOCUS_POLL_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new Error('Operation cancelled.');
}

function requireTargetSelector(target, key) {
  const selector = target?.[key];
  if (!selector) throw new TypeError(`target.${key} is required`);
  return selector;
}

export function focusKey(rect) {
  if (!rect) return 'none';
  return `${rect.kind}:${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`;
}

export async function getCaptchaFocusRect(page, target) {
  const challengeSelector = requireTargetSelector(target, 'challengeIframe');
  const checkboxSelector = requireTargetSelector(target, 'anchorIframe');

  try {
    const challenge = page.locator(challengeSelector);
    if ((await challenge.count()) > 0 && (await challenge.first().isVisible())) {
      const box = await challenge.first().boundingBox();
      if (box && box.width > 0) {
        return { x: box.x, y: box.y, w: box.width, h: box.height, kind: 'challenge' };
      }
    }

    const checkbox = page.locator(checkboxSelector);
    if ((await checkbox.count()) > 0 && (await checkbox.first().isVisible())) {
      const box = await checkbox.first().boundingBox();
      if (box && box.width > 0) {
        return { x: box.x, y: box.y, w: box.width, h: box.height, kind: 'checkbox' };
      }
    }
  } catch {
    /* Ignore transient page/frame changes while polling. */
  }
  return null;
}

export async function waitForCaptchaFocus(
  page,
  { target, onFocus = () => {}, signal, timeoutMs = DEFAULT_FOCUS_TIMEOUT_MS } = {}
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfCancelled(signal);
    const rect = await getCaptchaFocusRect(page, target);
    if (rect) {
      onFocus(rect);
      return rect;
    }
    await sleep(FOCUS_POLL_MS);
  }
  onFocus(null);
  return null;
}

export async function waitForCaptchaToken(
  page,
  { target, timeoutMs = DEFAULT_TOKEN_TIMEOUT_MS, signal, onChallenge = () => {}, onFocus = () => {} } = {}
) {
  const tokenSelectors = requireTargetSelector(target, 'tokenSelectors');
  const start = Date.now();
  let announcedChallenge = false;
  let lastFocusKey = '';

  while (Date.now() - start < timeoutMs) {
    throwIfCancelled(signal);

    const token = await page
      .$$eval(tokenSelectors, (els) => {
        for (const el of els) {
          if (el && typeof el.value === 'string' && el.value.length > 0) return el.value;
        }
        return '';
      })
      .catch(() => '');

    if (token && token.length > 0) return token;

    if (!announcedChallenge && (await isChallengeVisible(page, target))) {
      announcedChallenge = true;
      await onChallenge();
    }

    const rect = await getCaptchaFocusRect(page, target);
    const key = focusKey(rect);
    if (key !== lastFocusKey) {
      lastFocusKey = key;
      onFocus(rect);
    }

    await sleep(TOKEN_POLL_MS);
  }
  return '';
}

export function createCaptchaFocusTracker({ target, emitFocus }) {
  if (typeof emitFocus !== 'function') throw new TypeError('emitFocus must be a function');

  let busy = false;
  let running = false;
  let runId = 0;
  let publishId = 0;
  let lastKey = '';

  async function publish(page, expectedRunId = runId) {
    if (!running || expectedRunId !== runId || busy) return null;

    busy = true;
    const currentPublishId = ++publishId;
    try {
      if (!page || page.isClosed()) {
        if (expectedRunId === runId) stop();
        return null;
      }

      const rect = await getCaptchaFocusRect(page, target);
      if (!running || expectedRunId !== runId) return null;
      const key = focusKey(rect);
      if (key !== lastKey) {
        lastKey = key;
        emitFocus(rect);
      }
      return rect;
    } finally {
      if (currentPublishId === publishId) busy = false;
    }
  }

  function start(page) {
    stop(false);
    running = true;
    const currentRunId = ++runId;
    lastKey = '';
    return publish(page, currentRunId);
  }

  function stop(emitNull = true) {
    running = false;
    runId++;
    publishId++;
    busy = false;
    lastKey = '';
    if (emitNull) emitFocus(null);
  }

  return { publish, start, stop };
}

async function isChallengeVisible(page, target) {
  const challengeSelector = requireTargetSelector(target, 'challengeIframe');
  try {
    const frame = page.locator(challengeSelector);
    if ((await frame.count()) === 0) return false;
    return await frame.first().isVisible();
  } catch {
    return false;
  }
}
