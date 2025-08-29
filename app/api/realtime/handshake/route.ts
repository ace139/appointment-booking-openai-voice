import { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const auth = req.headers.get("authorization");
    if (!auth) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Pass through the SDK identification header if present
    const sdkHeader = req.headers.get("x-openai-agents-sdk") || undefined;

    const sdpOffer = await req.text();
    console.log("[Handshake] Inbound SDP offer length:", sdpOffer?.length || 0);
    if (!sdpOffer || !sdpOffer.includes("v=")) {
      return new Response(JSON.stringify({ error: "Invalid SDP offer" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Forward the SDP offer to OpenAI Realtime Calls endpoint server-side
    console.log("[Handshake] Forwarding to OpenAI Calls (model=gpt-realtime)...");
    const upstream = await fetch(
      // Provide model explicitly on GA calls endpoint
      "https://api.openai.com/v1/realtime/calls?model=gpt-realtime",
      {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/sdp",
          ...(sdkHeader ? { "X-OpenAI-Agents-SDK": sdkHeader } : {}),
        },
        body: sdpOffer,
      }
    );

    const answerText = await upstream.text();
    console.log("[Handshake] Upstream status:", upstream.status, "answer length:", answerText?.length || 0);
    if (!upstream.ok) {
      console.error("Realtime handshake upstream error", upstream.status, answerText);
    }
    if (!upstream.ok) {
      // Return upstream error details for easier debugging in client
      const errorPayload = answerText && answerText.trim().length > 0
        ? answerText
        : JSON.stringify({ error: "Upstream error", status: upstream.status });
      return new Response(errorPayload, {
        status: upstream.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Respond with SDP answer payload
    return new Response(answerText, {
      status: 200,
      headers: { "Content-Type": "application/sdp" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || "Handshake failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
