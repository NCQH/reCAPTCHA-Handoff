export const PORTS = {
  operator: 3000
};

export const TARGET = {
  mode: 'google-demo',
  url: 'https://www.google.com/recaptcha/api2/demo?hl=en',
  submit: 'input[type="submit"], button[type="submit"]',
  tokenSelectors: 'textarea[name="g-recaptcha-response"]',
  anchorIframe: 'iframe[src*="/recaptcha/api2/anchor"]',
  challengeIframe: 'iframe[src*="/recaptcha/api2/bframe"]',
  successText: 'Verification Success'
};

export const STATES = {
  OPENING: 'OPENING',
  AWAIT_CHECKBOX: 'AWAIT_CHECKBOX',
  AWAIT_CHALLENGE: 'AWAIT_CHALLENGE',
  TOKEN_READY: 'TOKEN_READY',
  SUBMITTING: 'SUBMITTING',
  DONE: 'DONE',
  FAILED: 'FAILED'
};

export const TOKEN_TIMEOUT_MS = Number(process.env.TOKEN_TIMEOUT_MS || 120_000);
export const RESULT_TIMEOUT_MS = Number(process.env.RESULT_TIMEOUT_MS || 15_000);
export const MAX_OPEN_RETRIES = Number(process.env.MAX_OPEN_RETRIES || 2);
