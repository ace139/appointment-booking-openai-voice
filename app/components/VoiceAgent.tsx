"use client";

import { useEffect, useRef, useState } from "react";
import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC } from "@openai/agents-realtime";

export default function VoiceAgent() {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>("");
  const sessionRef = useRef<RealtimeSession | null>(null);
  const micStopRef = useRef<null | (() => void)>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playheadRef = useRef<number>(0);

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
      src.onended = () => src.disconnect();
    } catch (e) {
      console.warn("[VoiceAgent] WS player: enqueue failed", e);
    }
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
      });

      session.on("history_updated", (history: any[]) => {
        console.log("[VoiceAgent] history_updated items=", Array.isArray(history) ? history.length : 0);
        // Extract readable transcript/text from the latest assistant message
        try {
          if (!Array.isArray(history) || history.length === 0) return;
          const last = history[history.length - 1];
          if (!last || last.type !== "message") return;
          // Assistant output can be output_text or output_audio (with optional transcript)
          if (last.role === "assistant" && Array.isArray(last.content)) {
            // Prefer output_text; fallback to output_audio.transcript
            const textPart = [...last.content].reverse().find((c: any) => c?.type === "output_text" && c.text);
            if (textPart?.text) {
              setTranscript(textPart.text);
              return;
            }
            const audioPart = [...last.content].reverse().find((c: any) => c?.type === "output_audio" && c.transcript);
            if (audioPart?.transcript) {
              setTranscript(audioPart.transcript);
              return;
            }
          }
          // Also surface user input text if assistant hasn’t spoken yet
          if (last.role === "user" && Array.isArray(last.content)) {
            const userText = [...last.content].reverse().find((c: any) => c?.type === "input_text" && c.text)?.text;
            if (userText) setTranscript(userText);
          }
        } catch (e) {
          // Non-fatal; keep UI responsive
          console.warn("[VoiceAgent] Failed to parse transcript from history", e);
        }
      });

      // Extra event logs for visibility
      (session as any).on?.("audio_start", () => console.log("[VoiceAgent] audio_start"));
      (session as any).on?.("audio_stopped", () => {
        console.log("[VoiceAgent] audio_stopped");
        // Reset playhead to avoid long gaps
        if (audioCtxRef.current) playheadRef.current = audioCtxRef.current.currentTime;
      });
      (session as any).on?.("audio_interrupted", () => console.log("[VoiceAgent] audio_interrupted"));
      (session as any).on?.("agent_start", (_ctx: any, a: any) => console.log("[VoiceAgent] agent_start", a?.name));
      (session as any).on?.("agent_end", (_ctx: any, a: any, output: any) => console.log("[VoiceAgent] agent_end", a?.name, output));
      (session as any).on?.("agent_handoff", (_ctx: any, from: any, to: any) => console.log("[VoiceAgent] agent_handoff", from?.name, "->", to?.name));
      (session as any).on?.("agent_tool_start", (_ctx: any, _a: any, tool: any, details: any) => console.log("[VoiceAgent] agent_tool_start", tool?.name, details));
      (session as any).on?.("agent_tool_end", (_ctx: any, _a: any, tool: any, result: any) => console.log("[VoiceAgent] agent_tool_end", tool?.name, result));
      (session as any).on?.("tool_approval_requested", (_ctx: any, _a: any, approval: any) => console.log("[VoiceAgent] tool_approval_requested", approval));
      (session as any).on?.("mcp_tools_changed", (tools: any) => console.log("[VoiceAgent] mcp_tools_changed", tools?.map((t: any) => t?.name)));
      (session as any).on?.("mcp_tool_call_completed", (_ctx: any, _a: any, call: any) => console.log("[VoiceAgent] mcp_tool_call_completed", call?.name));

      // Transport-level logging
      try {
        (session as any).transport?.on?.("connection_change", (s: any) => console.log("[VoiceAgent] transport connection_change:", s));
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
      await session.connect({ apiKey: client_secret });
      console.log("[VoiceAgent] Connected.");

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
    <div className="max-w-2xl mx-auto p-6 bg-white rounded-lg shadow-lg">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Voice Assistant Demo</h2>
        <p className="text-gray-600">Real-time voice conversation with AI using OpenAI Realtime API</p>
      </div>

      <div className="mb-6">
        <div className={`text-lg font-medium mb-2 ${getStatusColor()}`}>
          Status: {getStatusMessage()}
        </div>
        
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
            <p className="text-red-700 font-medium">Error:</p>
            <p className="text-red-600 text-sm">{error}</p>
          </div>
        )}

        {transcript && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
            <p className="text-blue-700 font-medium">Last Transcript:</p>
            <p className="text-blue-600 text-sm">{transcript}</p>
          </div>
        )}
      </div>

      <div className="flex gap-4 justify-center">
        <button
          onClick={start}
          disabled={status !== "idle"}
          className={`px-6 py-3 rounded-lg font-medium transition-colors ${
            status === "idle"
              ? "bg-blue-600 hover:bg-blue-700 text-white"
              : "bg-gray-300 text-gray-500 cursor-not-allowed"
          }`}
        >
          Start Voice Chat
        </button>
        
        <button
          onClick={stop}
          disabled={status === "idle"}
          className={`px-6 py-3 rounded-lg font-medium transition-colors ${
            status !== "idle"
              ? "bg-red-600 hover:bg-red-700 text-white"
              : "bg-gray-300 text-gray-500 cursor-not-allowed"
          }`}
        >
          Stop
        </button>
      </div>

      <div className="mt-8 text-sm text-gray-500">
        <h3 className="font-medium mb-2">Instructions:</h3>
        <ul className="list-disc list-inside space-y-1">
          <li>Click "Start Voice Chat" to begin</li>
          <li>Allow microphone access when prompted by your browser</li>
          <li>Wait for the "Connected" status</li>
          <li>Speak naturally - the AI will respond with voice</li>
          <li>Click "Stop" to end the conversation</li>
        </ul>
      </div>
    </div>
  );
}
