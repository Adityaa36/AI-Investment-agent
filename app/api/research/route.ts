// app/api/research/route.ts
// Backend API endpoint that receives a company name and returns the AI agent's analysis.
// This is a Next.js API Route (App Router) — it handles POST requests to /api/research.

import { NextResponse } from "next/server";
import { runResearchAgent } from "@/lib/agent";

// Allow up to 60 seconds for the agent to complete its research
// (it makes multiple API calls, so it takes 15-40 seconds typically)
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    // 1. Parse the request body
    const body = await request.json();
    const { companyName } = body;

    // 2. Validate input
    if (!companyName || typeof companyName !== "string" || companyName.trim() === "") {
      return NextResponse.json(
        { error: "Please provide a company name." },
        { status: 400 }
      );
    }

    // 3. Run the AI research agent
    const trimmedName = companyName.trim();
    console.log(`\n📨 Received research request for: "${trimmedName}"`);
    const startTime = Date.now();

    const result = await runResearchAgent(trimmedName);

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`⏱️ Research completed in ${durationSec}s\n`);

    // 4. Return the structured result
    return NextResponse.json({
      success: true,
      company: trimmedName,
      duration: `${durationSec}s`,
      ...result,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred";
    console.error("❌ Research API Error:", message);

    return NextResponse.json(
      {
        error: `Research failed: ${message}. Please check your API keys and try again.`,
      },
      { status: 500 }
    );
  }
}
