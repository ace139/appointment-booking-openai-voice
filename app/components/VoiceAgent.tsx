"use client";

import { useEffect, useRef, useState } from "react";
import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC } from "@openai/agents-realtime";

export default function VoiceAgent() {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>("");
  const [messages, setMessages] = useState<Array<{ id: string; role: 'user'|'assistant'|'system'; text: string; status?: string }>>([]);
  const [speaking, setSpeaking] = useState<boolean>(false);
  const [thinking, setThinking] = useState<boolean>(false);
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  const lastLatencyMsRef = useRef<number | null>(null);
  const lastTurnStartRef = useRef<number | null>(null);
  const sessionRef = useRef<RealtimeSession | null>(null);
  const micStopRef = useRef<null | (() => void)>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playheadRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const listeningTimeoutRef = useRef<number | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const messageTimesRef = useRef<Record<string, number>>({});
  const messageMetaRef = useRef<Record<string, any>>({});
  const lastSpeechStartAtRef = useRef<number | null>(null);
  // Track last assistant message id and pending metrics to avoid stale closures
  const lastAssistantIdRef = useRef<string | null>(null);
  const pendingLatencyRef = useRef<number | null>(null);
  const pendingUsageRef = useRef<null | { inTok: number; outTok: number; inDet?: any; outDet?: any }>(null);
  // Queue for arbitrary meta updates when assistant message id is not yet known
  const pendingMetaUpdatesRef = useRef<Array<(id: string) => void>>([]);

  function withAssistantMetaUpdate(fn: (id: string) => void) {
    const id = lastAssistantIdRef.current;
    if (id) fn(id);
    else pendingMetaUpdatesRef.current.push(fn);
  }

  // Turn detection + interruption knobs (pre-session)
  const [vadMode, setVadMode] = useState<"semantic_vad" | "server_vad">("semantic_vad");
  const [interruptResponse, setInterruptResponse] = useState<boolean>(true);
  const [silenceDurationMs, setSilenceDurationMs] = useState<number>(400);
  const [prefixPaddingMs, setPrefixPaddingMs] = useState<number>(300);
  const [threshold, setThreshold] = useState<number>(0.5);
  const [eagerness, setEagerness] = useState<number>(0.6); // semantic_vad only
  const [listening, setListening] = useState<boolean>(false);
  const [toasts, setToasts] = useState<Array<{ id: number; kind: 'info'|'error'|'success'; text: string }>>([]);
  const toastIdRef = useRef(1);
  const [instructionsOpen, setInstructionsOpen] = useState<boolean>(false);
  const [activity, setActivity] = useState<Array<{ id: number; time: number; kind: string; text: string; durationMs?: number }>>([]);
  const activityIdRef = useRef(1);
  const activityLoggedUserIdsRef = useRef<Set<string>>(new Set());
  const activityLoggedAssistantIdsRef = useRef<Set<string>>(new Set());
  const [traceOpen, setTraceOpen] = useState<boolean>(false);

  function addToast(text: string, kind: 'info'|'error'|'success' = 'info', ttl = 2500) {
    const id = toastIdRef.current++;
    setToasts((t) => [...t, { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
  }

  function addActivity(text: string, kind = 'info', durationMs?: number) {
    setActivity((prev) => [{ id: activityIdRef.current++, time: Date.now(), kind, text, durationMs }, ...prev].slice(0, 12));
  }

  // UI glyphs
  const MicIcon = ({ className = "w-4 h-4" }) => (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 14a3 3 0 003-3V6a3 3 0 10-6 0v5a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 0014 0h-2zM11 19.93V22h2v-2.07A8.001 8.001 0 0020 13h-2a6 6 0 11-12 0H4a8.001 8.001 0 007 6.93z"/>
    </svg>
  );
  const StopIcon = ({ className = "w-4 h-4" }) => (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M6 6h12v12H6z"/>
    </svg>
  );
  const ChevronIcon = ({ open, className = "w-4 h-4" }: { open: boolean; className?: string }) => (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden style={{transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 150ms ease'}}>
      <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/>
    </svg>
  );

  // Utility: resample Float32 PCM to 24kHz Int16 PCM
  function resampleToPcm16(input: Float32Array, sourceRate: number, targetRate = 24000) {
    if (sourceRate === targetRate) {
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    }
    const ratio = sourceRate / targetRate;
    const newLength = Math.floor(input.length / ratio);
    const out = new Int16Array(newLength);
    let pos = 0;
    for (let i = 0; i < newLength; i++) {
      const idx = i * ratio;
      const idx0 = Math.floor(idx);
      const idx1 = Math.min(idx0 + 1, input.length - 1);
      const frac = idx - idx0;
      const sample = input[idx0] * (1 - frac) + input[idx1] * frac;
      const s = Math.max(-1, Math.min(1, sample));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  // Keyboard shortcut: Spacebar toggles start/stop when focus is not in an input
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== 'Space') return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      if (status === 'idle') start();
      else if (status === 'connected' || status === 'connecting' || status === 'minting-secret') stop();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [status]);

  // Auto-scroll chat to bottom for new messages when user is near the bottom
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) {
      try { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); } catch { el.scrollTop = el.scrollHeight; }
    }
  }, [messages.length]);

  async function startWebSocketMicStreaming(session: RealtimeSession) {
    console.log("[VoiceAgent] WS mic streaming: requesting microphone...");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = ensureAudioContext();
    // Load worklet once
    if (!(ctx as any).__micWorkletLoaded) {
      await ctx.audioWorklet.addModule("/worklets/mic-processor.js");
      (ctx as any).__micWorkletLoaded = true;
      console.log("[VoiceAgent] WS mic worklet loaded");
    }

    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, "mic-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    source.connect(worklet);

    // Keep processing graph alive without audible mic loopback
    const sink = ctx.createGain();
    sink.gain.value = 0.0;
    worklet.connect(sink);
    sink.connect(ctx.destination);

    let stopped = false;
    micStopRef.current = () => {
      if (stopped) return;
      console.log("[VoiceAgent] WS mic streaming: stopping...");
      stopped = true;
      try { worklet.disconnect(); } catch {}
      try { source.disconnect(); } catch {}
      try { sink.disconnect(); } catch {}
      stream.getTracks().forEach((t) => t.stop());
      micStopRef.current = null;
    };

    worklet.port.onmessage = (ev: MessageEvent) => {
      if (stopped) return;
      const buf: ArrayBuffer | undefined = ev.data?.buffer;
      if (!buf) return;
      const float = new Float32Array(buf);
      const pcm16 = resampleToPcm16(float, ctx.sampleRate, 24000);
      try {
        (session as any).sendAudio(pcm16.buffer, { commit: false });
      } catch (e) {
        console.warn("[VoiceAgent] WS mic streaming send failed", e);
      }
    };

    console.log("[VoiceAgent] WS mic streaming: started @", ctx.sampleRate, "Hz → 24kHz pcm16");
  }

  function ensureAudioContext() {
    if (!audioCtxRef.current) {
      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      audioCtxRef.current = new Ctx();
      playheadRef.current = audioCtxRef.current.currentTime;
      console.log("[VoiceAgent] WS player: AudioContext created @", audioCtxRef.current.sampleRate, "Hz");
    }
    return audioCtxRef.current!;
  }

  function enqueuePcm16Playback(pcm16: Int16Array, sampleRate = 24000) {
    try {
      const ctx = ensureAudioContext();
      const frames = pcm16.length;
      // Convert to float32 in [-1, 1]
      const floatData = new Float32Array(frames);
      for (let i = 0; i < frames; i++) floatData[i] = pcm16[i] / 0x8000;
      const buffer = ctx.createBuffer(1, frames, sampleRate);
      buffer.getChannelData(0).set(floatData);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime + 0.02, playheadRef.current);
      const duration = frames / sampleRate;
      src.start(startAt);
      playheadRef.current = startAt + duration;
      // Auto cleanup
      activeSourcesRef.current.add(src);
      src.onended = () => {
        try { src.disconnect(); } catch {}
        activeSourcesRef.current.delete(src);
      };
    } catch (e) {
      console.warn("[VoiceAgent] WS player: enqueue failed", e);
    }
  }

  function stopAllQueuedAudioPlayback() {
    try {
      activeSourcesRef.current.forEach((src) => {
        try { src.stop(); } catch {}
        try { src.disconnect(); } catch {}
      });
    } finally {
      activeSourcesRef.current.clear();
      if (audioCtxRef.current) playheadRef.current = audioCtxRef.current.currentTime;
    }
  }

  function buildTurnDetectionConfig() {
    if (vadMode === "server_vad") {
      return {
        type: "server_vad",
        interruptResponse,
        silenceDurationMs,
        prefixPaddingMs,
        threshold,
      } as any;
    }
    // semantic_vad
    return {
      type: "semantic_vad",
      // keep ability to compare with/without auto interrupt behavior
      interruptResponse,
      // eagerness affects when a turn is considered done
      eagerness,
    } as any;
  }

  async function start() {
    setError(null);
    setStatus("minting-secret");

    try {
      console.log("[VoiceAgent] Start clicked: minting client secret...");
      // Get client secret from our API
      const resp = await fetch("/api/realtime/client-secret", { method: "POST" });
      if (!resp.ok) {
        const errorData = await resp.json();
        setError(`Failed to mint client secret: ${errorData.error}`);
        setStatus("idle");
        return;
      }
      const { client_secret } = await resp.json();
      console.log("[VoiceAgent] Received client secret (ek length):", client_secret?.length);

      // Create the agent with simple instructions and preferred voice
      const agent = new RealtimeAgent({
        name: "Demo Assistant",
        voice: "alloy",
        instructions:
          "You are a helpful voice assistant. Be concise and friendly in your responses. This is a demo application.",
      });

      // Create session with model configuration aligned with server-minted session
      const model = "gpt-realtime" as const;
      // Use a server-relayed WebRTC handshake to avoid browser-to-OpenAI SDP/CORS issues
      const transportEnv = process.env.NEXT_PUBLIC_REALTIME_TRANSPORT;
      const relayUrl = `${window.location.origin}/api/realtime/handshake`;
      const session = new RealtimeSession(agent, {
        model,
        transport:
          transportEnv === "websocket"
            ? "websocket"
            : new OpenAIRealtimeWebRTC({ baseUrl: relayUrl }),
      });

      // Set up event listeners
      session.on("audio", (audioEvent: any) => {
        try {
          console.log("[VoiceAgent] audio event", audioEvent?.type || typeof audioEvent, audioEvent);
          if (transportEnv === "websocket") {
            const buf: ArrayBuffer | undefined = audioEvent?.data;
            if (buf && buf.byteLength > 0) {
              enqueuePcm16Playback(new Int16Array(buf), 24000);
            }
          }
        } catch (e) {
          console.warn("[VoiceAgent] audio handler failed", e);
        }
      });

      session.on("error", (e: any) => {
        console.error("[VoiceAgent] Session error:", e);
        setError(JSON.stringify(e));
        addToast("Session error", "error", 4000);
        addActivity("Session error", 'error');
        withAssistantMetaUpdate((id) => {
          const meta = (messageMetaRef.current[id] ||= {});
          const steps = (meta.steps ||= []);
          steps.push({ type: 'error', name: 'session', status: 'failed', at: Date.now(), text: (e?.message || 'Unknown error') });
        });
      });

      session.on("history_updated", (history: any[]) => {
        console.log("[VoiceAgent] history_updated items=", Array.isArray(history) ? history.length : 0);
        // Extract readable messages and maintain a simple chat log
        try {
          if (!Array.isArray(history)) return;
          const out: Array<{ id: string; role: 'user'|'assistant'|'system'; text: string; status?: string }> = [];
          for (const item of history) {
            if (!item || item.type !== 'message') continue;
            let text = '';
            if (Array.isArray(item.content)) {
              if (item.role === 'assistant') {
                const textPart = [...item.content].reverse().find((c: any) => c?.type === 'output_text' && c.text);
                const audioPart = [...item.content].reverse().find((c: any) => c?.type === 'output_audio' && c.transcript);
                text = textPart?.text || audioPart?.transcript || '';
              } else if (item.role === 'user') {
                const userText = [...item.content].reverse().find((c: any) => c?.type === 'input_text' && c.text)?.text;
                const userAudio = [...item.content].reverse().find((c: any) => c?.type === 'input_audio' && c.transcript)?.transcript;
                text = userText || userAudio || '';
              } else {
                const sysText = [...item.content].reverse().find((c: any) => c?.type === 'input_text' && c.text)?.text;
                text = sysText || '';
              }
            }
            // Prefer stable id. Some snapshots include both id and itemId; use id first.
            out.push({ id: item.id || item.itemId || Math.random().toString(36).slice(2), role: item.role, text, status: item.status });
          }
          // Merge with previous messages to preserve last known text
          setMessages((prev) => {
            const prevById = new Map(prev.map((p) => [p.id, p] as const));
            const merged = out.map((item) => {
              const prevItem = prevById.get(item.id);
              if ((!item.text || item.text.trim() === '') && prevItem?.text) {
                return { ...item, text: prevItem.text };
              }
              return item;
            });
            return merged;
          });
          // Keep a simple “last transcript” convenience string for the header
          const last = out[out.length - 1];
          if (last && last.text) setTranscript(last.text);
          // Time tracking for items
          const times = messageTimesRef.current;
          for (const m of out) if (!times[m.id]) times[m.id] = Date.now();
          // Track latest assistant id and apply any pending metrics/updates
          const latestAssistant = [...out].reverse().find((m) => m.role === 'assistant');
          lastAssistantIdRef.current = latestAssistant?.id || null;
          if (latestAssistant) {
            const meta = (messageMetaRef.current[latestAssistant.id] ||= {});
            if (pendingLatencyRef.current !== null && typeof meta.latencyMs === 'undefined') {
              meta.latencyMs = pendingLatencyRef.current;
              pendingLatencyRef.current = null;
            }
            if (pendingUsageRef.current) {
              const { inTok, outTok, inDet, outDet } = pendingUsageRef.current;
              meta.tokensIn = inTok; meta.tokensOut = outTok; meta.tokenDetails = { in: inDet, out: outDet };
              pendingUsageRef.current = null;
            }
            if (pendingMetaUpdatesRef.current.length > 0) {
              const queue = pendingMetaUpdatesRef.current.splice(0, pendingMetaUpdatesRef.current.length);
              queue.forEach((fn) => { try { fn(latestAssistant.id); } catch (e) { console.warn('[VoiceAgent] pending meta update failed', e); } });
            }
          }

          // Record Activity entries for newly observed messages using stable ids
          for (let i = 0; i < out.length; i++) {
            const item = out[i];
            if (item.role === 'user') {
              if (!activityLoggedUserIdsRef.current.has(item.id)) {
                activityLoggedUserIdsRef.current.add(item.id);
                addActivity('User turn', 'info');
              }
            } else if (item.role === 'assistant') {
              const already = activityLoggedAssistantIdsRef.current.has(item.id);
              const isFinal = item.status && item.status !== 'in_progress';
              if (!already && isFinal) {
                activityLoggedAssistantIdsRef.current.add(item.id);
                const meta = messageMetaRef.current[item.id] || {};
                let ms: number | undefined = typeof meta.latencyMs === 'number' ? meta.latencyMs : undefined;
                // Fallback: derive latency from message first-seen times vs prior user message
                if (typeof ms !== 'number') {
                  const assistantSeen = messageTimesRef.current[item.id];
                  const prevUser = [...out.slice(0, i)].reverse().find((m) => m.role === 'user');
                  const prevUserSeen = prevUser ? messageTimesRef.current[prevUser.id] : undefined;
                  if (assistantSeen && prevUserSeen) {
                    const delta = assistantSeen - prevUserSeen;
                    if (delta > 0 && Number.isFinite(delta)) ms = delta;
                  }
                }
                addActivity(ms ? `Assistant responded in ${(ms/1000).toFixed(2)}s` : 'Assistant responded', 'metric', ms);
                // Also attach derived latency to the message meta so the UI can show it,
                // but don't override if a more accurate audio_start latency already exists.
                if (typeof (messageMetaRef.current[item.id] ||= {}).latencyMs === 'undefined' && typeof ms === 'number') {
                  messageMetaRef.current[item.id].latencyMs = ms;
                }
              }
            }
          }
        } catch (e) {
          console.warn("[VoiceAgent] Failed to parse transcript from history", e);
        }
      });

      // Extra event logs for visibility
      (session as any).on?.("audio_start", () => {
        console.log("[VoiceAgent] audio_start");
        setSpeaking(true);
        setThinking(false);
        // First audio latency from turn start
        if (lastTurnStartRef.current) {
          const ms = Date.now() - lastTurnStartRef.current;
          setLastLatencyMs(ms);
          lastLatencyMsRef.current = ms;
          addActivity(`First audio latency`, 'metric', ms);
          // Bind to known assistant id or queue until history provides it
          const aId = lastAssistantIdRef.current;
          if (aId) {
            const meta = (messageMetaRef.current[aId] ||= {});
            if (typeof meta.latencyMs === 'undefined') meta.latencyMs = ms;
          } else {
            pendingLatencyRef.current = ms;
          }
          lastTurnStartRef.current = null;
        }
      });
      (session as any).on?.("audio_stopped", () => {
        console.log("[VoiceAgent] audio_stopped");
        // Reset playhead to avoid long gaps
        if (audioCtxRef.current) playheadRef.current = audioCtxRef.current.currentTime;
        setSpeaking(false);
      });
      (session as any).on?.("audio_interrupted", () => {
        console.log("[VoiceAgent] audio_interrupted");
        // Show a brief listening cue
        setListening(true);
        if (listeningTimeoutRef.current) {
          window.clearTimeout(listeningTimeoutRef.current);
        }
        listeningTimeoutRef.current = window.setTimeout(() => setListening(false), 600);
        // In WS mode, we control playback locally — stop any queued audio immediately
        if (transportEnv === "websocket") {
          stopAllQueuedAudioPlayback();
        }
        addToast("Interrupted", "info", 1200);
        withAssistantMetaUpdate((id) => {
          const meta = (messageMetaRef.current[id] ||= {});
          meta.interrupted = true;
          meta.interruptedCause = 'barge-in';
        });
      });

      // Turn lifecycle → show a 'Thinking' pill while the model is preparing a response
      (session as any).on?.("turn_started", () => {
        setThinking(true);
        lastTurnStartRef.current = Date.now();
        setLastLatencyMs(null);
        lastLatencyMsRef.current = null;
      });
      (session as any).on?.("turn_done", (evt: any) => {
        setThinking(false);
        try {
          const usage = evt?.response?.usage;
          if (usage) {
            const inTok = usage.inputTokens ?? usage.input_tokens ?? 0;
            const outTok = usage.outputTokens ?? usage.output_tokens ?? 0;
            const inDet = usage.inputTokensDetails ?? usage.input_tokens_details ?? {};
            const outDet = usage.outputTokensDetails ?? usage.output_tokens_details ?? {};
            const cachedIn = inDet.cached_tokens ?? inDet.cached ?? inDet.input_cached_tokens;
            const cachedLabel = cachedIn ? ` (cached ${cachedIn})` : '';
            addActivity(`Usage: in ${inTok}${cachedLabel}, out ${outTok}`, 'metric');
            // Attach to the latest assistant message if we know it; otherwise queue
            const aId = lastAssistantIdRef.current;
            if (aId) {
              const meta = (messageMetaRef.current[aId] ||= {});
              if (typeof meta.latencyMs === 'undefined' && lastLatencyMsRef.current !== null) meta.latencyMs = lastLatencyMsRef.current;
              meta.tokensIn = inTok; meta.tokensOut = outTok; meta.tokenDetails = { in: inDet, out: outDet };
            } else {
              pendingUsageRef.current = { inTok, outTok, inDet, outDet };
            }
          }
        } catch {}
      });

      // Output audio cleared → infer cause
      (session as any).on?.("output_audio_buffer.cleared", () => {
        const cause = lastSpeechStartAtRef.current && Date.now() - lastSpeechStartAtRef.current < 2000 ? 'user speech' : 'manual clear';
        addActivity(`Output audio cleared (${cause})`, 'interrupt');
        withAssistantMetaUpdate((id) => {
          const meta = (messageMetaRef.current[id] ||= {});
          meta.outputCleared = cause;
        });
      });

      // Also reflect listening on server VAD speech start/stop
      (session as any).on?.("input_audio_buffer.speech_started", () => {
        setListening(true);
        lastSpeechStartAtRef.current = Date.now();
        if (listeningTimeoutRef.current) window.clearTimeout(listeningTimeoutRef.current);
        listeningTimeoutRef.current = window.setTimeout(() => setListening(false), 600);
      });
      (session as any).on?.("input_audio_buffer.speech_stopped", () => {
        if (listeningTimeoutRef.current) {
          window.clearTimeout(listeningTimeoutRef.current);
          listeningTimeoutRef.current = null;
        }
        setListening(false);
      });
      (session as any).on?.("agent_start", (_ctx: any, a: any) => console.log("[VoiceAgent] agent_start", a?.name));
      (session as any).on?.("agent_end", (_ctx: any, a: any, output: any) => console.log("[VoiceAgent] agent_end", a?.name, output));
      (session as any).on?.("agent_handoff", (_ctx: any, from: any, to: any) => {
        console.log("[VoiceAgent] agent_handoff", from?.name, "->", to?.name);
        withAssistantMetaUpdate((id) => {
          const meta = (messageMetaRef.current[id] ||= {});
          meta.handoff = { from: from?.name, to: to?.name, at: Date.now() };
        });
      });
      (session as any).on?.("agent_tool_start", (_ctx: any, _a: any, tool: any, details: any) => {
        console.log("[VoiceAgent] agent_tool_start", tool?.name, details);
        withAssistantMetaUpdate((id) => {
          const meta = (messageMetaRef.current[id] ||= {});
          const steps = (meta.steps ||= []);
          steps.push({ type: 'tool', name: tool?.name || 'tool', status: 'running', at: Date.now(), details });
        });
      });
      (session as any).on?.("agent_tool_end", (_ctx: any, _a: any, tool: any, result: any) => {
        console.log("[VoiceAgent] agent_tool_end", tool?.name, result);
        withAssistantMetaUpdate((id) => {
          const meta = (messageMetaRef.current[id] ||= {});
          const steps = (meta.steps ||= []);
          const idx = steps.slice().reverse().findIndex((s: any) => s.type==='tool' && s.name === (tool?.name || 'tool'));
          const i = idx >= 0 ? steps.length - 1 - idx : -1;
          if (i >= 0) steps[i] = { ...steps[i], status: 'done', doneAt: Date.now(), result };
          else steps.push({ type: 'tool', name: tool?.name || 'tool', status: 'done', at: Date.now(), doneAt: Date.now(), result });
        });
      });
      (session as any).on?.("tool_approval_requested", (_ctx: any, _a: any, approval: any) => {
        console.log("[VoiceAgent] tool_approval_requested", approval);
        withAssistantMetaUpdate((id) => {
          const meta = (messageMetaRef.current[id] ||= {});
          const steps = (meta.steps ||= []);
          steps.push({ type: 'approval', name: approval?.name || 'approval', status: 'requested', at: Date.now(), approval });
        });
      });
      (session as any).on?.("mcp_tools_changed", (tools: any) => {
        console.log("[VoiceAgent] mcp_tools_changed", tools?.map((t: any) => t?.name));
        withAssistantMetaUpdate((id) => {
          const meta = (messageMetaRef.current[id] ||= {});
          const steps = (meta.steps ||= []);
          const names = (tools||[]).map((t:any)=>t?.name).filter(Boolean).join(', ');
          steps.push({ type: 'mcp', name: 'tools_changed', status: 'info', at: Date.now(), text: names });
        });
      });
      (session as any).on?.("mcp_tool_call_completed", (_ctx: any, _a: any, call: any) => {
        console.log("[VoiceAgent] mcp_tool_call_completed", call?.name);
        withAssistantMetaUpdate((id) => {
          const meta = (messageMetaRef.current[id] ||= {});
          const steps = (meta.steps ||= []);
          steps.push({ type: 'mcp', name: call?.name || 'mcp', status: 'done', at: Date.now() });
        });
      });

      // Transport-level logging
      try {
        (session as any).transport?.on?.("connection_change", (s: any) => {
          console.log("[VoiceAgent] transport connection_change:", s);
          addToast(`Connection: ${s}`, s === 'connected' ? 'success' : 'info');
        });
        if (process.env.NEXT_PUBLIC_DEBUG_REALTIME === "1") {
          (session as any).transport?.on?.("*", (evt: any) => {
            const t = evt?.type || evt?.event || "unknown";
            console.debug("[VoiceAgent] transport * event:", t, evt);
          });
        }
      } catch (err) {
        console.warn("[VoiceAgent] transport logging unavailable", err);
      }

      // Setup audio processing for microphone input
      // - WebRTC: automatic (handled by SDK)
      // - WebSocket: we must stream mic audio manually
      if (transportEnv === "websocket") {
        try {
          await startWebSocketMicStreaming(session);
        } catch (e) {
          console.error("[VoiceAgent] Failed to start WS mic streaming", e);
        }
      }
      
      setStatus("connecting");
      console.log("[VoiceAgent] Connecting to realtime... transport=", transportEnv === "websocket" ? "websocket" : "webrtc", "relay=", relayUrl);

      // Connect to OpenAI Realtime
      // This automatically configures audio input/output in the browser via WebRTC
      // Apply pre-start turn detection knobs on connect so they take effect for the session
      const initialSessionConfig = {
        audio: {
          input: {
            turnDetection: buildTurnDetectionConfig(),
          },
        },
      } as any;

      await session.connect({ apiKey: client_secret, initialSessionConfig });
      console.log("[VoiceAgent] Connected.");
      addActivity('Connected', 'success');

      sessionRef.current = session;
      setStatus("connected");

    } catch (error) {
      console.error("[VoiceAgent] Error starting voice agent:", error);
      setError(`Error: ${error instanceof Error ? error.message : String(error)}`);
      setStatus("idle");
    }
  }

  function stop() {
    if (sessionRef.current) {
      console.log("[VoiceAgent] Stop clicked: closing session...");
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (micStopRef.current) {
      micStopRef.current();
    }
    // Ensure any queued WS audio is stopped
    stopAllQueuedAudioPlayback();
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch {}
      audioCtxRef.current = null;
      playheadRef.current = 0;
    }
    
    setStatus("idle");
    setError(null);
    setTranscript("");
    setListening(false);
    setThinking(false);
    setLastLatencyMs(null);
    addActivity('Stopped', 'info');
    activityLoggedUserIdsRef.current.clear();
    activityLoggedAssistantIdsRef.current.clear();
    if (listeningTimeoutRef.current) {
      window.clearTimeout(listeningTimeoutRef.current);
      listeningTimeoutRef.current = null;
    }
  }

  const getStatusColor = () => {
    switch (status) {
      case "connected": return "text-green-600";
      case "connecting": case "minting-secret": return "text-yellow-600";
      case "idle": return "text-gray-600";
      default: return "text-blue-600";
    }
  };

  const getStatusMessage = () => {
    switch (status) {
      case "idle": return "Click Start to begin voice conversation";
      case "minting-secret": return "Getting authorization...";
      case "connecting": return "Connecting to voice service...";
      case "connected": return "🎤 Connected! Speak naturally with the AI";
      default: return status;
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-6 pb-6 pt-10 md:pt-14">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Main content */}
        <div className="md:col-span-2 bg-white rounded-lg shadow-lg p-6 relative">
          <div className="text-center mb-6">
            <h2 className="text-2xl font-bold text-gray-800 mb-2">Voice Assistant Demo</h2>
            <p className="text-gray-600">Real-time voice conversation with AI using OpenAI Realtime API</p>
          </div>

          {/* Voice activity orb */}
          <div className="mb-6 flex justify-center">
            <div className="relative">
              <div
                className={`orb ${listening ? 'orb--listening' : ''} ${speaking ? 'orb--speaking' : ''} ${status==='connected' && !listening && !speaking ? 'orb--idleConnected' : ''}`}
                aria-hidden
              >
                <div className="absolute inset-0 flex items-center justify-center text-white/95">
                  <div className="orb-bars">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              </div>
              {(status === 'connecting' || status === 'minting-secret') && (
                <div className="orb-spinner" aria-hidden />
              )}
            </div>
          </div>

          <div className="mb-4" aria-live="polite">
            <div className="flex items-center justify-center gap-2 flex-wrap">
              {/* Status chip */}
              {(() => {
                const chip = (() => {
                  switch (status) {
                    case 'idle': return { label: 'Idle', bg: 'bg-gray-100', text: 'text-gray-700', dot: '#6b7280', ring: 'ring-1 ring-gray-300' };
                    case 'minting-secret': return { label: 'Authorizing', bg: 'bg-yellow-100', text: 'text-yellow-700', dot: '#f59e0b', ring: 'ring-1 ring-yellow-200' };
                    case 'connecting': return { label: 'Connecting', bg: 'bg-yellow-100', text: 'text-yellow-700', dot: '#f59e0b', ring: 'ring-1 ring-yellow-200' };
                    case 'connected': return { label: 'Connected', bg: 'bg-green-100', text: 'text-green-700', dot: '#16a34a', ring: 'ring-1 ring-green-200' };
                    default: return { label: status, bg: 'bg-blue-100', text: 'text-blue-700', dot: '#2563eb', ring: 'ring-1 ring-blue-200' };
                  }
                })();
                return (
                  <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${chip.bg} ${chip.text} ${chip.ring}`}>
                    <span className="w-2 h-2 rounded-full" style={{ background: chip.dot }} />
                    {chip.label}
                  </span>
                );
              })()}
              {listening && status === 'connected' && (
                <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-green-100 text-green-700 text-xs font-medium">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  Listening
                </span>
              )}
              {thinking && (
                <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-medium">
                  <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                  Thinking
                </span>
              )}
              {speaking && (
                <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-100 text-purple-700 text-xs font-medium">
                  <span className="w-2 h-2 rounded-full bg-purple-500" />
                  Speaking
                </span>
              )}
              {speaking && lastLatencyMs !== null && (
                <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-100 text-purple-700 text-xs font-medium">
                  <span className="w-2 h-2 rounded-full bg-purple-500" />
                  First Audio {lastLatencyMs} ms
                </span>
              )}
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
                <p className="text-red-700 font-medium">Error:</p>
                <p className="text-red-600 text-sm">{error}</p>
              </div>
            )}
            {/* Transcript area */}
            <div className="relative border-t border-gray-100 mt-4">
              <div ref={chatScrollRef} className="space-y-4 h-[min(52vh,520px)] overflow-auto pr-1 pt-6 pb-12">
                {messages.map((m) => (
                  <div key={m.id} className={`flex items-start gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {m.role !== 'user' && (
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-white" style={{background:"linear-gradient(135deg, rgb(var(--primary)), rgb(var(--accent)))"}}>
                      <span className="text-xs">AI</span>
                    </div>
                  )}
                  <div className="relative max-w-[75%]">
                    <div className={`rounded-2xl px-4 py-2 shadow ${m.role === 'user' ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-gray-100 text-gray-800 rounded-bl-sm'}`}>
                      {/* Inline event chips for assistant turns */}
                      {m.role==='assistant' && (() => { const meta = messageMetaRef.current[m.id] || {}; const steps = meta.steps || []; const hasHandoff = !!meta.handoff; if ((steps && steps.length>0) || hasHandoff || meta.interrupted) {
                        return (
                          <div className="mb-1 flex flex-wrap gap-1">
                            {hasHandoff && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] bg-blue-100 text-blue-700">Handoff: {meta.handoff.from || '—'} → {meta.handoff.to || '—'}</span>
                            )}
                            {steps.map((s: any, idx: number) => {
                              if (s.type==='tool') {
                                const base = s.status==='running' ? 'bg-indigo-100 text-indigo-700' : 'bg-green-100 text-green-700';
                                return <span key={idx} className={`px-2 py-0.5 rounded-full text-[10px] inline-flex items-center gap-1 ${base}`}>{s.status==='running' ? <span className="inline-block w-2 h-2 rounded-full bg-indigo-500 animate-pulse"/> : <span className="inline-block w-2 h-2 rounded-full bg-green-500"/>}{s.status==='running' ? 'Using' : 'Used'} {s.name}</span>;
                              }
                              if (s.type==='approval') {
                                return <span key={idx} className="px-2 py-0.5 rounded-full text-[10px] bg-yellow-100 text-yellow-800">Approval needed: {s.name}</span>;
                              }
                              if (s.type==='mcp') {
                                return <span key={idx} className="px-2 py-0.5 rounded-full text-[10px] bg-fuchsia-100 text-fuchsia-800">MCP {s.name}{s.text?` · ${s.text}`:''}</span>;
                              }
                              if (s.type==='error') {
                                return <span key={idx} className="px-2 py-0.5 rounded-full text-[10px] bg-red-100 text-red-700">Error: {s.text || s.name}</span>;
                              }
                              return null;
                            })}
                            {meta.interrupted && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] bg-gray-200 text-gray-700">Interrupted{meta.interruptedCause?` · ${meta.interruptedCause}`:''}</span>
                            )}
                          </div>
                        );
                      } return null; })()}
                      <div className="text-sm whitespace-pre-wrap">{m.text || (m.role==='assistant' && m.status==='in_progress' ? (<span className="typing-dots"><span></span><span></span><span></span></span>) : '')}</div>
                      <div className={`mt-1 text-[10px] ${m.role==='user' ? 'text-white/70' : 'text-gray-500'} flex items-center gap-2 flex-wrap`}>
                        <span>{new Date(messageTimesRef.current[m.id] || Date.now()).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
                        {m.role==='assistant' && (() => {
                          const meta = messageMetaRef.current[m.id] || {};
                          const ms = meta.latencyMs as number | undefined;
                          if (!ms) return null;
                          const color = ms <= 300
                            ? 'bg-green-100 text-green-700'
                            : ms <= 1000
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-red-100 text-red-700';
                          return (
                            <span className="inline-flex items-center gap-1">
                              <span>•</span>
                              <span className={`rounded px-1.5 py-[1px] text-[10px] ${color}`}>{ms} ms</span>
                            </span>
                          );
                        })()}
                        {m.role==='assistant' && (() => { const meta = messageMetaRef.current[m.id] || {}; if (!meta.tokensIn && !meta.tokensOut) return null; const cached = meta.tokenDetails?.in?.cached_tokens ?? meta.tokenDetails?.in?.cached ?? meta.tokenDetails?.in?.input_cached_tokens; const cachedLabel = cached ? ` (cached ${cached})` : ''; return (<span>• tokens {meta.tokensIn ?? 0}/{meta.tokensOut ?? 0}{cachedLabel}</span>); })()}
                        {m.role==='assistant' && (() => { const meta = messageMetaRef.current[m.id] || {}; return meta.interrupted ? (<span>• interrupted ({meta.interruptedCause})</span>) : null; })()}
                        {m.role==='assistant' && m.status==='in_progress' ? <span>• typing…</span> : null}
                      </div>
                    </div>
                  </div>
                    {m.role === 'user' && (
                      <div className="w-8 h-8 rounded-full flex items-center justify-center bg-gray-200 text-gray-700">
                        <span className="text-xs">You</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {/* subtle fades to separate from status/controls */}
              <div className="pointer-events-none absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-[rgb(var(--surface))] to-transparent" />
              <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-[rgb(var(--surface))] to-transparent" />
            </div>
          </div>

          <div className="flex flex-wrap gap-4 justify-center mt-4">
            <button
              onClick={start}
              disabled={status !== "idle"}
              className={`px-6 py-3 rounded-lg font-medium transition-colors focus-ring ${
                status === "idle"
                  ? "bg-blue-600 hover:bg-blue-700 text-white"
                  : "bg-gray-300 text-gray-500 cursor-not-allowed"
              }`}
            >
              <span className="inline-flex items-center gap-2"><MicIcon /> Start Voice Chat</span>
            </button>
            <button
              onClick={stop}
              disabled={status === "idle"}
              className={`px-6 py-3 rounded-lg font-medium transition-colors focus-ring ${
                status !== "idle"
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "bg-gray-300 text-gray-500 cursor-not-allowed"
              }`}
            >
              <span className="inline-flex items-center gap-2"><StopIcon /> Stop</span>
            </button>
          </div>

          <div className="mt-8 text-sm">
            <button
              onClick={() => setInstructionsOpen((o) => !o)}
              className="flex items-center gap-2 text-gray-800 font-medium focus-ring"
              aria-expanded={instructionsOpen}
              aria-controls="instructions-panel"
            >
              <ChevronIcon open={instructionsOpen} /> Instructions
            </button>
            <button
              onClick={() => setTraceOpen((o) => !o)}
              className="ml-4 inline-flex items-center gap-2 text-gray-600 hover:text-gray-800 text-sm focus-ring"
              aria-expanded={traceOpen}
              aria-controls="trace-panel"
            >
              <span className={`w-2 h-2 rounded-full ${traceOpen ? 'bg-green-500' : 'bg-gray-400'}`} />
              {traceOpen ? 'Hide Trace' : 'Show Trace'}
            </button>
            {instructionsOpen && (
              <div id="instructions-panel" className="mt-3 card border border-gray-200 bg-[rgb(var(--surface-2))]">
                <div className="p-4">
                  <ul className="list-disc list-inside space-y-1 text-gray-700">
                    <li>Click "Start Voice Chat" to begin</li>
                    <li>Allow microphone access when prompted by your browser</li>
                    <li>Wait for the "Connected" status</li>
                    <li>Speak naturally — the AI responds with voice</li>
                    <li>Click "Stop" to end the conversation</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        </div>
        {/* Toasts */}
        {toasts.length > 0 && (
          <div className="pointer-events-none fixed right-4 top-20 z-40 flex flex-col gap-2">
            {toasts.map((t) => (
              <div key={t.id} className={`px-3 py-2 rounded-lg shadow text-sm pointer-events-auto ${t.kind==='error' ? 'bg-red-600 text-white' : t.kind==='success' ? 'bg-green-600 text-white' : 'bg-black/80 text-white'}`}>
                {t.text}
              </div>
            ))}
          </div>
        )}

        {/* Side panel */}
        <aside className="bg-white rounded-lg shadow-lg p-4 md:sticky md:top-6 h-fit">
          <h3 className="font-semibold text-gray-800 mb-3">Turn Detection & Interrupt</h3>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <span className="text-gray-700 flex items-center gap-2">VAD Mode
                <span className="tooltip">
                  <span className="w-4 h-4 inline-flex items-center justify-center rounded-full bg-gray-200 text-gray-700 text-[10px]">i</span>
                  <span className="tooltip-panel">Choose how turns end. Semantic VAD uses a turn model for natural pauses. Server VAD uses volume + silence for snappy turn ends.</span>
                </span>
              </span>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-1 text-gray-700">
                  <input
                    type="radio"
                    name="vad-mode"
                    checked={vadMode === "semantic_vad"}
                    onChange={() => setVadMode("semantic_vad")}
                    disabled={status !== "idle"}
                  />
                  Semantic VAD
                </label>
                <label className="flex items-center gap-1 text-gray-700">
                  <input
                    type="radio"
                    name="vad-mode"
                    checked={vadMode === "server_vad"}
                    onChange={() => setVadMode("server_vad")}
                    disabled={status !== "idle"}
                  />
                  Server VAD
                </label>
              </div>
            </div>

            <label className="flex items-center gap-2 text-gray-700">
              <input
                type="checkbox"
                checked={interruptResponse}
                onChange={(e) => setInterruptResponse(e.target.checked)}
                disabled={status !== "idle"}
              />
              Auto-interrupt
              <span className="tooltip">
                <span className="w-4 h-4 inline-flex items-center justify-center rounded-full bg-gray-200 text-gray-700 text-[10px]">i</span>
                <span className="tooltip-panel">When enabled, the assistant audio is cut as soon as your speech starts, reducing talk-over during barge-in.</span>
              </span>
            </label>

            {vadMode === "semantic_vad" ? (
              <div className="grid grid-cols-1 gap-3">
                <label className="flex flex-col text-gray-700">
                  <span className="flex items-center justify-between">
                    <span className="flex items-center gap-2">Eagerness
                      <span className="tooltip">
                        <span className="w-4 h-4 inline-flex items-center justify-center rounded-full bg-gray-200 text-gray-700 text-[10px]">i</span>
                        <span className="tooltip-panel">Higher eagerness ends the turn sooner; lower will wait for possible continuation like “uhm…”.</span>
                      </span>
                    </span>
                    <span className="text-xs text-gray-500">{eagerness.toFixed(2)}</span>
                  </span>
                  <input
                    type="range"
                    step={0.05}
                    min={0.3}
                    max={0.9}
                    value={eagerness}
                    onChange={(e) => setEagerness(Number(e.target.value))}
                    disabled={status !== "idle"}
                    className="w-full"
                  />
                  <span className="text-xs text-gray-500">0.4–0.7 recommended</span>
                </label>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3">
                <label className="flex flex-col text-gray-700">
                  <span className="flex items-center justify-between">
                    <span className="flex items-center gap-2">Silence (ms)
                      <span className="tooltip">
                        <span className="w-4 h-4 inline-flex items-center justify-center rounded-full bg-gray-200 text-gray-700 text-[10px]">i</span>
                        <span className="tooltip-panel">Lower silence cuts sooner (faster turns) but risks cutting users off mid-sentence.</span>
                      </span>
                    </span>
                    <span className="text-xs text-gray-500">{silenceDurationMs}ms</span>
                  </span>
                  <input
                    type="range"
                    min={200}
                    max={1200}
                    step={50}
                    value={silenceDurationMs}
                    onChange={(e) => setSilenceDurationMs(Number(e.target.value))}
                    disabled={status !== "idle"}
                    className="w-full"
                  />
                  <span className="text-xs text-gray-500">300–600 recommended</span>
                </label>
                <label className="flex flex-col text-gray-700">
                  <span className="flex items-center justify-between">
                    <span className="flex items-center gap-2">Prefix Padding (ms)
                      <span className="tooltip">
                        <span className="w-4 h-4 inline-flex items-center justify-center rounded-full bg-gray-200 text-gray-700 text-[10px]">i</span>
                        <span className="tooltip-panel">Pads audio before detected speech so the model captures the very start of words.</span>
                      </span>
                    </span>
                    <span className="text-xs text-gray-500">{prefixPaddingMs}ms</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1000}
                    step={50}
                    value={prefixPaddingMs}
                    onChange={(e) => setPrefixPaddingMs(Number(e.target.value))}
                    disabled={status !== "idle"}
                    className="w-full"
                  />
                  <span className="text-xs text-gray-500">200–400 recommended</span>
                </label>
                <label className="flex flex-col text-gray-700">
                  <span className="flex items-center justify-between">
                    <span className="flex items-center gap-2">Threshold
                      <span className="tooltip">
                        <span className="w-4 h-4 inline-flex items-center justify-center rounded-full bg-gray-200 text-gray-700 text-[10px]">i</span>
                        <span className="tooltip-panel">Lower = more sensitive (quiet rooms). Higher = fewer false starts (noisy rooms). Recommended 0.4–0.6.</span>
                      </span>
                    </span>
                    <span className="text-xs text-gray-500">{threshold.toFixed(2)}</span>
                  </span>
                  <input
                    type="range"
                    min={0.2}
                    max={0.8}
                    step={0.05}
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                    disabled={status !== "idle"}
                    className="w-full"
                  />
                  <span className="text-xs text-gray-500">0.4–0.6 recommended</span>
                </label>
              </div>
            )}
            <div className="pt-2">
              <button
                onClick={() => {
                  if (vadMode === 'semantic_vad') {
                    setEagerness(0.6);
                    setInterruptResponse(true);
                  } else {
                    setSilenceDurationMs(400);
                    setPrefixPaddingMs(300);
                    setThreshold(0.5);
                    setInterruptResponse(true);
                  }
                }}
                disabled={status !== 'idle'}
                className={`px-3 py-1.5 rounded-md text-sm border ${status==='idle' ? 'bg-white hover:bg-gray-50 text-gray-700' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
              >
                Reset to defaults
              </button>
            </div>
          </div>
        </aside>

        {/* Activity panel under controls on desktop, below on mobile */}
        {/* Trace toggle & drawer (developer view) */}
        <div className="md:col-span-1">
          <TracePanel activity={activity} open={traceOpen} onClose={() => setTraceOpen(false)} />
        </div>
      </div>
    </div>
  );
}

function TracePanel({ activity, open = false, onClose }: { activity: Array<{ id: number; time: number; kind: string; text: string; durationMs?: number }>; open?: boolean; onClose?: () => void }) {
  return (
    <div className="bg-white rounded-lg shadow-lg p-4 mt-0 md:mt-0" id="trace-panel" hidden={!open}>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-gray-800">Trace</h3>
        <button onClick={onClose} className="text-sm text-gray-600 hover:text-gray-800">Close</button>
      </div>
      {activity.length === 0 ? (
        <p className="text-xs text-gray-500 mt-2">No recent events.</p>
      ) : (
        <ul className="space-y-1 max-h-48 overflow-auto mt-2">
          {activity.map((a) => (
            <li key={a.id} className="text-xs text-gray-700 flex items-center justify-between gap-2">
              <span className="truncate">{a.text}</span>
              <span className="text-[10px] text-gray-500 whitespace-nowrap">{typeof a.durationMs === 'number' ? `${(a.durationMs/1000).toFixed(2)}s` : new Date(a.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
