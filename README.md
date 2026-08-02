# Google reCAPTCHA Demo Handoff

Small Playwright CDP ScreenCast app for opening Google's public reCAPTCHA demo page and letting a human interact with the captcha inside one local UI. The project intentionally targets one Google demo module.

Target page:

```text
https://www.google.com/recaptcha/api2/demo?hl=en
```

## Demo

![Google reCAPTCHA demo handoff](docs/google-demo-module.gif)

## Components

| File | Role |
|---|---|
| `src/config.js` | Single Google demo target and selectors. |
| `src/browser.js` | Persistent browser context, CDP ScreenCast stream, CDP mouse dispatch. |
| `src/captcha-handoff.js` | Finds captcha iframe, tracks focus/crop, waits for token. |
| `src/job.js` | Opens Google demo, waits for human captcha, submits demo form. |
| `src/orchestrator.js` | Serves UI and WebSocket bridge. |
| `public/` | Local operator UI. |

## Architecture

The browser sends damage-driven JPEG frames through CDP `Page.startScreencast`. The server forwards the base64 payload to the local UI over WebSocket; mouse and wheel events travel back through CDP `Input.dispatchMouseEvent`.

The focus crop is refreshed when ScreenCast frames arrive. There is no screenshot `setInterval` or 250 ms frame loop. The remaining 250 ms DOM check in `waitForCaptchaFocus` only waits for the reCAPTCHA iframe to appear after navigation.

## Run

```powershell
npm start
```

Open:

```text
http://localhost:3000
```

Click `Open demo`, then interact with the Google reCAPTCHA widget in the live-view panel.

## Browser Requirements

`app` mode requires a browser with the CDP ScreenCast API. The following binaries were available and launch-tested locally:

| Browser | Path | Result |
|---|---|---|
| Google Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe` | Real E2E pass |
| Microsoft Edge | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | Launch smoke pass |
| Playwright Chromium | `%LOCALAPPDATA%\ms-playwright\chromium-1223\...\chrome.exe` | Available fallback |
| Playwright headless shell | `%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1223\...\chrome-headless-shell.exe` | Available fallback |

Chrome and Edge are the recommended choices. Edge is Chromium-based, and both expose the CDP `Page.startScreencast` method used by this module. Firefox/WebKit are not drop-in alternatives for the current implementation because they do not provide this CDP Page domain API.

To select a browser explicitly (the variable name is retained for compatibility and also accepts an Edge executable):

```powershell
$env:CHROME_EXECUTABLE_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
# or:
$env:CHROME_EXECUTABLE_PATH="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
npm start
```

## Browser Mode

| `BROWSER_VIEW` | Behavior |
|---|---|
| `app` (default) | Headless, streamed into the app. Prefers system Chrome/Edge, then Playwright headless-shell. |
| `hidden` | Headful browser positioned off-screen. |
| `desktop` | Headful visible browser for debugging. |

Optional profile and proxy settings:

```powershell
$env:PROFILE_DIR="C:\tmp\captcha-profile"
$env:PROXY_SERVER="http://user:pass@ip:port"
npm start
```

`BROWSER_NO_SANDBOX=true` is available only for an explicitly isolated browser/container environment; it is disabled by default.

## Test

```powershell
npm.cmd test
```

### Real browser test

The manual E2E path is:

1. Start the app and open `http://localhost:3000`.
2. Click `Open demo` and confirm the live JPEG view displays the checkbox.
3. Click the checkbox through the live view.
4. Confirm the UI reports `Google is showing an image challenge` and the crop follows the challenge.
5. Solve the image challenge manually if you want to verify token and form submission; CAPTCHA solving is intentionally not automated.

Last local verification (2026-08-03): Chrome reached the real Google demo, ScreenCast frames displayed successfully, input click reached the image challenge, and the operator UI reported no console errors. The test stopped at the human-required challenge.

## License

MIT. This project is a local demo against Google's public reCAPTCHA demo page. Respect the terms of any site you test against.
