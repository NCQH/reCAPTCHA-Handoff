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

export function createCaptchaFocusTracker({ target, emitFocus, intervalMs = FOCUS_POLL_MS }) {
  if (typeof emitFocus !== 'function') throw new TypeError('emitFocus must be a function');

  let timer = null;
  let busy = false;
  let runId = 0;
  let lastKey = '';

  async function publish(page, expectedRunId = runId) {
    if (expectedRunId !== runId) return;
    if (!page || page.isClosed()) {
      if (expectedRunId === runId) stop();
      return;
    }

    const rect = await getCaptchaFocusRect(page, target);
    if (expectedRunId !== runId) return;
    const key = focusKey(rect);
    if (key !== lastKey) {
      lastKey = key;
      emitFocus(rect);
    }
  }

  function start(page) {
    stop(false);
    const currentRunId = ++runId;
    lastKey = '';
    publish(page, currentRunId).catch(() => {});
    timer = setInterval(() => {
      if (busy) return;
      busy = true;
      publish(page, currentRunId).finally(() => {
        busy = false;
      });
    }, intervalMs);
  }

  function stop(emitNull = true) {
    runId++;
    if (timer) clearInterval(timer);
    timer = null;
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
