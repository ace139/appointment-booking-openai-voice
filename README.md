# Realtime Voice Agent (GA) — Next.js + OpenAI Agents SDK

A production‑ready implementation of OpenAI’s Realtime API (GA) for voice conversations, built with Next.js 14 + TypeScript and the official `@openai/agents-realtime` SDK. It supports both WebRTC (browser‑native, auto mic/speaker) and WebSocket (server‑side/phone) transports, with a secure server relay for WebRTC SDP.

**Highlights**

- **GA Model**: `gpt-realtime`
- **Secure Ephemerals**: Mints client secrets via GA endpoint
- **WebRTC**: Auto mic+speaker, lowest latency
- **WebSocket**: Manual mic streaming + audio playback included
- **Server Relay**: Browser → Next.js → OpenAI Calls for robust SDP
- **Rich Debugging**: Verbose logs to diagnose end‑to‑end flow

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
