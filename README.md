# Google reCAPTCHA Demo Handoff

Small Playwright + CDP screencast app for opening Google's public reCAPTCHA demo page and letting a human interact with the captcha inside one local UI.

Target page:

```text
https://www.google.com/recaptcha/api2/demo
```

## Components

| File | Role |
|---|---|
| `src/config.js` | Single Google demo target and selectors. |
| `src/browser.js` | Persistent browser context, CDP screencast, mouse dispatch. |
| `src/captcha-handoff.js` | Finds captcha iframe, tracks focus/crop, waits for token. |
| `src/job.js` | Opens Google demo, waits for human captcha, submits demo form. |
| `src/orchestrator.js` | Serves UI and WebSocket bridge. |
| `public/` | Local operator UI. |

## Run

```powershell
npm start
```

Open:

```text
http://localhost:3000
```

Click `Open demo`, then interact with the Google reCAPTCHA widget in the live-view panel.

## Browser Mode

| `BROWSER_VIEW` | Behavior |
|---|---|
| `app` (default) | Headless, streamed into the app. Prefers installed Playwright headless-shell. |
| `hidden` | Headful browser positioned off-screen. |
| `desktop` | Headful visible browser for debugging. |

Optional profile and proxy settings:

```powershell
$env:PROFILE_DIR="C:\tmp\captcha-profile"
$env:PROXY_SERVER="http://user:pass@ip:port"
npm start
```

## Test

```powershell
npm.cmd test
```
