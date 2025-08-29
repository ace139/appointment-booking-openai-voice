import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
  }

  try {
    // GA: Use client_secrets to mint a Realtime client secret
    const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      // GA client_secrets currently mints a generic client token; do not include unsupported fields.
      body: JSON.stringify({}),
    });

    if (!r.ok) {
      const errorText = await r.text();
      console.error("OpenAI API error:", errorText);
      return NextResponse.json({ error: `OpenAI API error: ${errorText}` }, { status: 502 });
    }
    
    const data = await r.json();
    // Support both possible shapes
    const clientSecret =
      (typeof data.client_secret === "string" ? data.client_secret : undefined) ||
      (data.client_secret && data.client_secret.value) ||
      data.value ||
      data.secret;
    if (!clientSecret) {
      console.error("Unexpected client_secret response shape:", data);
      return NextResponse.json({ error: "Invalid client secret response" }, { status: 502 });
    }
    return NextResponse.json({ client_secret: clientSecret });
  } catch (error) {
    console.error("Error minting client secret:", error);
    return NextResponse.json({ error: "Failed to mint client secret" }, { status: 500 });
  }
}
