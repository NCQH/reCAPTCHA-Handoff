import {
  TARGET,
  STATES,
  TOKEN_TIMEOUT_MS,
  RESULT_TIMEOUT_MS,
  MAX_OPEN_RETRIES
} from './config.js';
import { resetPage } from './browser.js';
import { waitForCaptchaFocus, waitForCaptchaToken } from './captcha-handoff.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CancelledJob extends Error {
  constructor() {
    super('Job was cancelled.');
  }
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new CancelledJob();
}

export async function runJob(emit, sendFocus = () => {}, options = {}) {
  const { signal, onPage } = options;
  try {
    throwIfCancelled(signal);
    const page = await resetPage();
    throwIfCancelled(signal);
    onPage?.(page);
    sendFocus(null);

    await openGoogleDemo(page, emit, sendFocus, signal);
    throwIfCancelled(signal);

    emit(STATES.AWAIT_CHECKBOX, {
      message: 'Click "I\'m not a robot" in the demo captcha widget.'
    });

    const token = await waitForCaptchaToken(page, {
      target: TARGET,
      timeoutMs: TOKEN_TIMEOUT_MS,
      signal,
      onFocus: sendFocus,
      onChallenge: () => emit(STATES.AWAIT_CHALLENGE, {
        message: 'Google is showing an image challenge. Complete it in the live view.'
      })
    });

    if (!token) {
      sendFocus(null);
      emit(STATES.FAILED, { message: 'Timed out waiting for the captcha token.' });
      return { ok: false, reason: 'TOKEN_TIMEOUT' };
    }

    sendFocus(null);
    emit(STATES.TOKEN_READY, { message: 'Captcha token is ready. Submitting the demo form...' });

    throwIfCancelled(signal);
    emit(STATES.SUBMITTING, { message: "Submitting Google's demo form..." });
    await submitGoogleDemo(page);

    throwIfCancelled(signal);
    await waitForDemoResult(page, signal);
    emit(STATES.DONE, { message: 'Google demo captcha was submitted successfully.' });
    return { ok: true };
  } catch (err) {
    if (err instanceof CancelledJob || signal?.aborted) {
      sendFocus(null);
      return { ok: false, reason: 'CANCELLED' };
    }
    emit(STATES.FAILED, { message: `Error: ${err.message}` });
    return { ok: false, reason: err.message };
  }
}

async function openGoogleDemo(page, emit, sendFocus, signal) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_OPEN_RETRIES; attempt++) {
    try {
      throwIfCancelled(signal);
      emit(STATES.OPENING, {
        message: `Opening Google reCAPTCHA demo${attempt > 1 ? ` - retry ${attempt}` : ''}...`
      });
      await page.goto(TARGET.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForCaptchaFocus(page, { target: TARGET, onFocus: sendFocus, signal });
      throwIfCancelled(signal);
      return;
    } catch (err) {
      if (err instanceof CancelledJob || signal?.aborted) throw err;
      lastErr = err;
      if (attempt < MAX_OPEN_RETRIES) await sleep(1000);
    }
  }
  throw lastErr;
}

async function submitGoogleDemo(page) {
  const submit = page.locator(TARGET.submit).first();
  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    submit.click({ timeout: 5000 })
  ]);
}

async function waitForDemoResult(page, signal) {
  const start = Date.now();
  while (Date.now() - start < RESULT_TIMEOUT_MS) {
    throwIfCancelled(signal);
    const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
    if (bodyText.includes(TARGET.successText)) return;
    await sleep(400);
  }
  throw new Error('Google demo result page did not appear after submit.');
}
