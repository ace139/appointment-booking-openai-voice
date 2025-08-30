# Realtime Voice Agent (GA) — Next.js + OpenAI Agents SDK

A production‑ready implementation of OpenAI’s Realtime API (GA) for voice conversations, built with Next.js 14 + TypeScript and the official `@openai/agents-realtime` SDK. It supports both WebRTC (browser‑native, auto mic/speaker) and WebSocket (server‑side/phone) transports, with a secure server relay for WebRTC SDP.

**Highlights**

- **GA Model**: `gpt-realtime`
- **Secure Ephemerals**: Mints client secrets via GA endpoint
- **WebRTC**: Auto mic+speaker, lowest latency
- **WebSocket**: Manual mic streaming + audio playback included
- **Server Relay**: Browser → Next.js → OpenAI Calls for robust SDP
- **Inline UX**: Tool/MCP/approval/handoff chips directly in chat
- **Latency Metrics**: Color‑coded first‑audio latency next to timestamps
- **Rich Debugging**: Optional Trace drawer + verbose logs to diagnose flow

**Key Learnings Encapsulated**

- GA flow uses `POST /v1/realtime/client_secrets` to mint an `ek_…` client secret (no model in body)
- Realtime Calls (WebRTC) accept the model on the URL: `POST /v1/realtime/calls?model=gpt-realtime`
- WebRTC from browser needs an absolute relay URL; relative URLs error (Invalid URL)
- If you see “Expect line: v=”, you posted JSON to a Calls SDP endpoint (wrong URL or token)
- WebSocket transport does not auto‑handle audio — you must stream mic and play back audio

**Contents**

- Overview
- Setup
- Run
- Architecture
- Code Map
- Configuration
- Debugging
- Troubleshooting
- Notes for Production
- [Turn Detection & Interrupts](#turn-detection--interrupts)
- [UI & Observability](#ui--observability)

## Overview

- **Model**: `gpt-realtime` (GA)
- **SDKs**: `@openai/agents` + `@openai/agents-realtime`
- **Transports**:
  - WebRTC (default): microphone and speaker are automatically managed by the SDK in browser
  - WebSocket (optional): microphone streaming and audio playback implemented in this repo

## Setup

- Prerequisites: Node.js ≥ 18, access to OpenAI Realtime API
- Install dependencies: `npm install`
- Create `.env.local` with your server key:

```
OPENAI_API_KEY=sk-proj-XXXXXXXXXXXXXXXXXXXXXXXX
```

## Run

```
npm run dev
```

- Open `http://localhost:3000`
- Click “Start Voice Chat”, allow mic when prompted, talk, then “Stop”

## Architecture

```
Browser (Next.js App)
  ├─ WebRTC (default):
  │    RealtimeSession ↔ /api/realtime/handshake ↔ OpenAI /v1/realtime/calls?model=gpt-realtime
  │      - Server relays SDP offer/answer (application/sdp)
  │      - Ephemeral ek_ secret authenticates
  │
  └─ WebSocket (optional):
       RealtimeSession (websocket)
         - Mic manually streamed (24k PCM16)
         - Audio chunks played back via AudioContext

Server (Next.js API Routes)
  ├─ POST /api/realtime/client-secret → POST /v1/realtime/client_secrets (GA)
  └─ POST /api/realtime/handshake     → POST /v1/realtime/calls?model=gpt-realtime
```

## Code Map

- `app/components/VoiceAgent.tsx`
  - Client component using `RealtimeAgent` + `RealtimeSession`
  - WebRTC (auto mic/output) or WebSocket (manual mic/output)
  - Rich console logs; toggle raw transport logs via `NEXT_PUBLIC_DEBUG_REALTIME=1`
- `app/api/realtime/client-secret/route.ts`
  - GA: `POST https://api.openai.com/v1/realtime/client_secrets` (empty body)
  - Returns `ek_…` client secret to the browser
- `app/api/realtime/handshake/route.ts`
  - Accepts browser SDP offer
  - Forwards to `POST https://api.openai.com/v1/realtime/calls?model=gpt-realtime` with `Authorization: Bearer ek_…`
  - Returns SDP answer to the browser

## Configuration

- `OPENAI_API_KEY` (server): Required. A standard server key with access to Realtime
- `NEXT_PUBLIC_REALTIME_TRANSPORT` (client):
  - Omit for WebRTC (recommended in browsers)
  - Set to `websocket` to use WS (manual mic/output)
- `NEXT_PUBLIC_DEBUG_REALTIME` (client):
  - Set to `1` to log all raw transport events (`session.created`, `response.*`, etc.)

## Debugging

- Client console shows annotated logs:
  - Minting secret, connecting, connected, history updates, agent events
  - Transport `connection_change` and (optional) `*` raw events
  - For WS: mic streaming start/stop and playback events
- Server logs for handshake:
  - Inbound SDP length, upstream status, answer length
  - Upstream error body is surfaced in the API response for quick diagnosis

## Troubleshooting

- “api_version_mismatch”
  - Cause: Minted a beta token or wrong endpoint
  - Fix: Use GA `POST /v1/realtime/client_secrets` (this repo does), and Calls with `?model=gpt-realtime`

- “Unknown parameter: 'model'” on client secret mint
  - Cause: Sending `model` to `/client_secrets`
  - Fix: Send an empty JSON body `{}`

- “Failed to parse SessionDescription. { Expect line: v=”
  - Cause: Calls endpoint returned JSON (error) instead of SDP
  - Fix: Use the server relay and ensure endpoint is `/v1/realtime/calls?model=gpt-realtime` with `Authorization: Bearer ek_…`

- “Failed to construct 'URL': Invalid URL”
  - Cause: Relative `baseUrl` for WebRTC transport
  - Fix: Use absolute `baseUrl`, e.g. ``${window.location.origin}/api/realtime/handshake``

- Connected but silent (WS)
  - Cause: WS transport doesn’t auto‑handle audio
  - Fix: Stream mic (24k PCM16) and play back `response.output_audio.delta` (implemented here)

- No mic prompt or blocked
  - Cause: Browser permission or non‑secure origin
  - Fix: Serve over HTTPS in production and allow mic access

## Notes for Production

- **HTTPS**: Required by browsers for mic access
- **Ephemeral tokens**: `ek_…` expire quickly; mint right before connect
- **Server relay**: Keep the handshake proxy; it avoids browser SDP/CORS quirks
- **Rate limits**: Monitor usage/events; add backoff/retry as needed
- **AudioWorklet**: Replace ScriptProcessorNode for lower latency (optional improvement)

## Turn Detection & Interrupts

This demo lets you explore how the Realtime API detects turn boundaries and handles barge‑in (interrupting the assistant while it is speaking).

VAD Modes
- Semantic VAD: Uses a turn detection model (on top of VAD) to semantically estimate when the user is done. Optimizes for natural pauses, fewer premature cutoffs. Supports the eagerness knob. Can add a little latency before responding.
- Server VAD: Uses volume/silence thresholds to detect start/end of speech. Optimizes for snappy turn ends and low latency. Supports threshold, silenceDurationMs, prefixPaddingMs knobs.
- Disable VAD: Set turn detection to null if you need manual control (push‑to‑talk, custom barge‑in). Then you must send input_audio_buffer.commit and response.create yourself.

Knobs & Practical Ranges
- eagerness (Semantic VAD): 0.4–0.7. Higher ends turns sooner (faster), but risks cutting off the user if they pause.
- silenceDurationMs (Server VAD): 300–600ms. Lower = faster end‑of‑turn, more risk of cutting the user.
- prefixPaddingMs (Server VAD): 200–400ms. Pads audio at the start so the model “hears” beginnings of words.
- threshold (Server VAD): 0.4–0.6. Lower = more sensitive in quiet rooms; higher = fewer false starts in noise.

Interrupts (Barge‑In)
- interruptResponse: When true, the server/SDK auto‑interrupts assistant audio as soon as the user starts speaking. This minimizes “talking over”.
- Client cancel/clear: When auto‑interrupt is off, clients should send response.cancel followed by output_audio_buffer.clear (WebRTC) to stop generation and cut current audio.
- Events involved:
  - input_audio_buffer.speech_started: server detected user speech (good moment to cut assistant audio if needed).
  - input_audio_buffer.speech_stopped: server detected end of user speech; a user message is created and response begins (if create_response).
  - output_audio_buffer.cleared (WebRTC): the assistant’s audio was cut (either by barge‑in or client clear).
  - response.output_item.done / response.done: response item/turn finalized (including cancelled/incomplete).

In This Demo
- UI (before starting): choose Semantic VAD (eagerness) or Server VAD (threshold/silence/prefix), and toggle server auto‑interrupt. These choices are applied when the session connects and remain until you press Stop.
- Stop Talking button: calls interrupt(), cancelling current speech and clearing audio immediately.
- WebRTC vs WebSocket:
  - WebRTC: mic/speaker handled by the SDK; output_audio_buffer.cleared covers clean barge‑in.
  - WebSocket: we enqueue PCM chunks into an AudioContext; on audio_interrupted we stop all queued sources and reset the playhead to avoid overlap.

Usage Notes
- If you need deterministic push‑to‑talk, disable VAD and explicitly commit the audio, then create a response.
- Choose Semantic VAD for more natural conversations; choose Server VAD for maximum snappiness and lowest latency.


## UI & Observability

This demo ships a modern, responsive UI with an “everything in the conversation” approach. End users see a single, coherent timeline; developers can open a Trace drawer when needed.

Layout & Theming
- Header: Sticky header with brand and a light/dark theme toggle (`data-theme`).
- Design tokens: CSS variables for colors, radii, shadows, and motion; soft radial background.
- Responsive: Two‑column layout (`grid-cols-1 md:grid-cols-3`); side panel is sticky on desktop and stacked on mobile.

Controls (Side Panel)
- VAD mode: Semantic VAD (eagerness) or Server VAD (threshold, silenceDurationMs, prefixPaddingMs).
- Interrupt toggle: `interruptResponse` enables server auto‑barge‑in when user speech starts.
- Sliders + tooltips: Sliders for each applicable knob with inline helper tooltips; disabled mid‑session.
- Reset: “Reset to defaults” sets recommended values for the selected mode.

Status & Feedback
- Indicator pills: Compact chips for core states — Idle, Authorizing, Connecting, Connected — plus live Listening, Thinking, Speaking, and “First Audio X ms”.
- Voice orb: Shimmer when idle‑connected; pulse while Listening/Speaking; dashed ring while Connecting.
- Toasts: Lightweight notices for connection changes and errors.

Transcript (Center Panel)
- Chat bubbles: User (right, blue) and Assistant (left, gray) with avatars and timestamps. Improved top/bottom breathing room and auto‑scroll.
- Streaming indicator: Animated typing dots while assistant is in_progress.
- Inline chips (assistant):
  - Tool usage: “Using {tool}” while running, then “Used {tool}” on completion
  - Approvals: “Approval needed: {name}” (status chip; wire to your approval flow if desired)
  - MCP: compact chip noting MCP activity (e.g., tools changed or a call completed)
  - Handoff: “Handoff: {from} → {to}”
  - Interrupts: “Interrupted · cause”
- Metrics row: Timestamp plus color‑coded latency chip and token usage when available.
  - Latency colors: green ≤300ms, yellow ≤1000ms, red >1000ms.

Audio UX & Interruption
- Output smoothing: Resets the Web Audio playhead on `audio_stopped` to avoid gaps.
- Barge‑in: On `audio_interrupted` (or `speech_started`), the UI notes an interrupt; in WS mode we also stop queued audio to prevent overlap.

Keyboard & Accessibility
- Shortcut: Spacebar toggles Start/Stop when focus is not in an input.
- Live regions: Status area uses `aria-live="polite"`.
- Focus styles: Visible focus ring on interactive controls.

Instructions
- Collapsible card: Instructions are wrapped in a collapsible panel with a chevron toggle for a cleaner surface by default.

Notes
- The UI applies VAD/interrupt settings at connect time and keeps them fixed for the session (per Realtime constraints).
- Metrics binding is resilient to event ordering: latency and token usage queue until the assistant message exists, then attach.

Developer Trace Drawer
- The historical Activity side panel has been replaced with a compact, optional Trace drawer.
- Toggle via the “Show Trace” button near Instructions. It mirrors key events for demos/debugging and is hidden by default for a cleaner end‑user experience.


## Example Flows

- WebRTC (default):
  - User clicks Start → mint `ek_…` → WebRTC SDP offer posted to relay → relay posts to Calls with `?model=gpt-realtime` → answer returns → auto mic/speaker → speak & hear

- WebSocket (set `NEXT_PUBLIC_REALTIME_TRANSPORT=websocket`):
  - User clicks Start → mint `ek_…` → WS connect → stream mic PCM16 → model transcribes/responds → play PCM16 audio chunks via AudioContext

## Development

- Type check: `npx tsc --noEmit`
- Lint: `npm run lint`
- Build: `npm run build`

## License

MIT
