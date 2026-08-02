# ADR-001: Use CDP ScreenCast for the reCAPTCHA live view

## Status

Accepted

## Date

2026-08-03

## Context

The single-module reCAPTCHA handoff originally captured a Playwright screenshot every 250 ms. That created a timer-driven capture loop, repeated screenshot work even when the page was unchanged, and added avoidable latency and memory pressure before forwarding frames to the operator UI.

The module needs a continuous live view, CDP mouse input, and a browser session that remains controlled by Playwright. The operator must still complete the CAPTCHA manually.

## Decision

Use the Chrome DevTools Protocol ScreenCast API from the Playwright CDP session:

- Start `Page.startScreencast` with JPEG output and the configured viewport bounds.
- Forward the CDP base64 frame payload directly to the WebSocket UI.
- Acknowledge every frame with `Page.screencastFrameAck`.
- Stop the stream and detach the CDP session during session cleanup.
- Refresh the focus crop from incoming frames instead of maintaining a second focus timer.

The supported browser selection is an explicit Chrome/Edge executable through `CHROME_EXECUTABLE_PATH`; Playwright Chromium/headless-shell remains the fallback when no system browser is available.

## Alternatives Considered

### Playwright screenshot polling

Rejected because a fixed 250 ms loop performs repeated capture work and couples stream latency to a timer. It also requires an in-flight guard to avoid overlapping screenshots.

### WebRTC or a separate media server

Rejected for this local one-target module because it adds signaling, media transport, and lifecycle complexity that CDP already avoids.

### Firefox/WebKit browser backends

Not selected because the implementation depends on the CDP `Page.startScreencast` and `Page.screencastFrame` APIs. Chrome and Edge provide the required CDP Page domain.

## Consequences

- Frame delivery is event-driven and avoids the screenshot timer.
- The browser must expose the required CDP ScreenCast API.
- WebSocket backpressure can drop stale frames while preserving the latest live view.
- The initial DOM readiness check still polls briefly for the reCAPTCHA iframe; this is separate from frame capture.
- CAPTCHA solving remains a human-in-the-loop step and is not automated.
