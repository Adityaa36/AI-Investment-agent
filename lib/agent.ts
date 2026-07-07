// lib/agent.ts
// Token-efficient investment research agent.
//
// The previous version used an iterative tool-calling loop. Each LLM turn
// replayed the full transcript plus prior tool outputs, which made cost grow
// quickly. This version deterministically gathers the required evidence,
// compacts it, and uses one final model call for investment synthesis.

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  CACHE_TTL_MS,
  getFinancialData,
  searchNews,
  searchWeb,
} from "./tools";

interface ResearchStep {
  tool: string;
  input: string;
  output: string;
}

export interface ResearchResult {
  verdict: string;
  confidence: string;
  summary: string;
  highlights?: {
    companyOverview: string;
    sector: string;
    marketCap: string;
    stockTicker: string;
  };
  reasoning?: {
    strengths: string[];
    risks: string[];
    financialHealth: string;
    growthPotential: string;
    competitivePosition: string;
    recentDevelopments: string;
    investmentCommittee?: string;
    whatWouldChangeOurView?: string[];
  };
  keyMetrics?: {
    peRatio: string;
    revenueGrowth: string;
    profitMargin: string;
    debtToEquity: string;
    [key: string]: string;
  };
  analystNote?: string;
  researchSteps: ResearchStep[];
  rawOutput: string;
  error?: string;
  optimizationMetrics?: {
    llmCallsBeforeEstimate: number;
    llmCallsAfter: number;
    estimatedInputTokens: number;
    cachedFinalAnalysis: boolean;
  };
}

const FINAL_ANALYSIS_TTL_MS = 30 * 60 * 1000;
const FINAL_MODEL = "google/gemini-2.5-flash";

const finalAnalysisCache = new Map<
  string,
  { value: ResearchResult; expiresAt: number }
>();

const KNOWN_TICKERS: Record<string, string[]> = {
  aapl: ["AAPL"],
  apple: ["AAPL"],
  "apple inc": ["AAPL"],
  msft: ["MSFT"],
  microsoft: ["MSFT"],
  "microsoft corporation": ["MSFT"],
  tsla: ["TSLA"],
  tesla: ["TSLA"],
  googl: ["GOOGL"],
  google: ["GOOGL"],
  alphabet: ["GOOGL"],
  amzn: ["AMZN"],
  amazon: ["AMZN"],
  meta: ["META"],
  nvidia: ["NVDA"],
  nvda: ["NVDA"],
  zomato: ["ZOMATO.BSE"],
  infosys: ["INFY"],
  infy: ["INFY"],
  reliance: ["RELIANCE.BSE"],
  "reliance industries": ["RELIANCE.BSE"],
  tcs: ["TCS.BSE"],
  "tata consultancy services": ["TCS.BSE"],
  "hdfc bank": ["HDB", "HDFCBANK.BSE"],
};

const SYNTHESIS_PROMPT = `You are an institutional investment analyst. Produce a concise, high-signal investment recommendation from the provided evidence.

Use the evidence packet only. Do not invent numbers. If evidence is missing or stale, lower confidence and say so briefly.

Return ONLY valid JSON with this exact shape:
{
  "verdict": "INVEST" or "PASS",
  "confidence": "HIGH" or "MEDIUM" or "LOW",
  "summary": "2-3 concise sentences with recommendation and core reason",
  "highlights": {
    "companyOverview": "1 concise paragraph, no more than 70 words",
    "sector": "sector or N/A",
    "marketCap": "value or N/A",
    "stockTicker": "ticker used or N/A"
  },
  "reasoning": {
    "strengths": ["strongest bull point 1 with numbers when available", "strongest bull point 2", "strongest bull point 3"],
    "risks": ["strongest bear point 1", "strongest bear point 2", "strongest bear point 3"],
    "financialHealth": "1-2 concise sentences",
    "growthPotential": "1-2 concise sentences",
    "competitivePosition": "1-2 concise sentences",
    "recentDevelopments": "1-2 concise sentences using top news only",
    "investmentCommittee": "short direct committee-style reasoning for the verdict",
    "whatWouldChangeOurView": ["trigger 1", "trigger 2", "trigger 3"]
  },
  "keyMetrics": {
    "peRatio": "actual value or N/A",
    "revenueGrowth": "actual value or N/A",
    "profitMargin": "actual value or N/A",
    "debtToEquity": "actual value or N/A"
  },
  "analystNote": "1-2 concise sentences on the key swing factor"
}

Style: concise institutional analyst memo. Prefer brevity over repetition.`;

function normalizeCompanyName(companyName: string): string {
  return companyName.trim().toLowerCase().replace(/\s+/g, " ");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength).trim()}...`
    : normalized;
}

function step(tool: string, input: Record<string, string>, output: string): ResearchStep {
  return {
    tool,
    input: JSON.stringify(input),
    output: truncate(output, 260),
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function initialTickerCandidates(companyName: string): string[] {
  const normalized = normalizeCompanyName(companyName);
  const exact = KNOWN_TICKERS[normalized] || KNOWN_TICKERS[normalized.replace(/\./g, "")];
  const looksLikeTicker = /^[A-Za-z0-9.]{1,12}$/.test(companyName.trim()) && !companyName.includes(" ");

  return unique([
    ...(exact || []),
    ...(looksLikeTicker ? [companyName.trim().toUpperCase()] : []),
  ]);
}

function extractTickerCandidates(text: string): string[] {
  const candidates: string[] = [];
  const commonFalsePositives = new Set([
    "CEO",
    "CFO",
    "COO",
    "IPO",
    "ETF",
    "USD",
    "NSE",
    "BSE",
    "NYSE",
    "NASDAQ",
  ]);

  const patterns = [
    /\b(?:ticker|symbol|stock code)\s*(?:is|:|-)?\s*([A-Z0-9]{1,10}(?:\.[A-Z]{2,4})?)\b/gi,
    /\b(?:NYSE|NASDAQ|NSE|BSE)\s*[:\-]?\s*([A-Z0-9]{1,10}(?:\.[A-Z]{2,4})?)\b/g,
    /\(([A-Z0-9]{1,10}(?:\.[A-Z]{2,4})?)\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.toUpperCase();
      if (candidate && !commonFalsePositives.has(candidate)) {
        candidates.push(candidate);
      }
    }
  }

  return unique(candidates).slice(0, 4);
}

function hasFinancialData(output: string): boolean {
  return !/^Could not find financial data|^Financial data lookup failed/i.test(output);
}

async function resolveFinancialData(
  companyName: string,
  profileEvidence: string,
  researchSteps: ResearchStep[]
): Promise<{ symbol: string; financialEvidence: string; tickerEvidence: string }> {
  const directCandidates = initialTickerCandidates(companyName);
  let tickerEvidence = "";
  let candidates = unique([
    ...directCandidates,
    ...extractTickerCandidates(profileEvidence),
  ]);

  if (candidates.length === 0) {
    const query = `${companyName} stock ticker symbol exchange`;
    tickerEvidence = await searchWeb(query, {
      ttlMs: CACHE_TTL_MS.companyProfile,
      num: 3,
    });
    researchSteps.push(step("web_search", { query }, tickerEvidence));
    candidates = extractTickerCandidates(tickerEvidence);
  }

  if (candidates.length === 0) {
    candidates = [companyName.trim().toUpperCase()];
  }

  let lastFinancialEvidence = "";
  let lastSymbol = candidates[0];

  for (const symbol of candidates.slice(0, 3)) {
    const financialEvidence = await getFinancialData(symbol);
    researchSteps.push(step("get_financial_data", { symbol }, financialEvidence));

    lastFinancialEvidence = financialEvidence;
    lastSymbol = symbol;

    if (hasFinancialData(financialEvidence)) {
      return { symbol, financialEvidence, tickerEvidence };
    }
  }

  return {
    symbol: lastSymbol,
    financialEvidence: lastFinancialEvidence,
    tickerEvidence,
  };
}

function buildEvidencePacket(input: {
  companyName: string;
  symbol: string;
  profileEvidence: string;
  tickerEvidence: string;
  financialEvidence: string;
  newsEvidence: string;
}): string {
  return [
    `Company requested: ${input.companyName}`,
    `Ticker used: ${input.symbol || "N/A"}`,
    "",
    "Company profile and competitive context:",
    truncate(input.profileEvidence, 1800),
    input.tickerEvidence
      ? `\nTicker evidence:\n${truncate(input.tickerEvidence, 700)}`
      : "",
    "",
    "Financial metrics:",
    truncate(input.financialEvidence, 1600),
    "",
    "Top recent news:",
    truncate(input.newsEvidence, 1500),
  ]
    .filter(Boolean)
    .join("\n");
}

function parseJsonOutput(output: string): Record<string, unknown> {
  let jsonStr = output;
  const codeBlockMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);

  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1];
  } else {
    const jsonObjMatch = output.match(/\{[\s\S]*\}/);
    if (jsonObjMatch) {
      jsonStr = jsonObjMatch[0];
    }
  }

  return JSON.parse(jsonStr);
}

function coerceResearchResult(
  parsed: Record<string, unknown>,
  fallbackOutput: string,
  researchSteps: ResearchStep[],
  metrics: ResearchResult["optimizationMetrics"]
): ResearchResult {
  return {
    verdict: String(parsed.verdict || "PASS"),
    confidence: String(parsed.confidence || "LOW"),
    summary: String(parsed.summary || ""),
    highlights: parsed.highlights as ResearchResult["highlights"],
    reasoning: parsed.reasoning as ResearchResult["reasoning"],
    keyMetrics: parsed.keyMetrics as ResearchResult["keyMetrics"],
    analystNote: String(parsed.analystNote || ""),
    researchSteps,
    rawOutput: fallbackOutput,
    optimizationMetrics: metrics,
  };
}

function getCachedFinal(companyName: string): ResearchResult | null {
  const cached = finalAnalysisCache.get(normalizeCompanyName(companyName));
  if (!cached || cached.expiresAt <= Date.now()) return null;
  const cachedMetrics = cached.value.optimizationMetrics;

  return {
    ...cached.value,
    optimizationMetrics: {
      llmCallsBeforeEstimate: cachedMetrics?.llmCallsBeforeEstimate ?? 5,
      estimatedInputTokens: cachedMetrics?.estimatedInputTokens ?? 0,
      llmCallsAfter: 0,
      cachedFinalAnalysis: true,
    },
  };
}

function setCachedFinal(companyName: string, result: ResearchResult): void {
  finalAnalysisCache.set(normalizeCompanyName(companyName), {
    value: result,
    expiresAt: Date.now() + FINAL_ANALYSIS_TTL_MS,
  });
}

export async function runResearchAgent(
  companyName: string
): Promise<ResearchResult> {
  const cachedFinal = getCachedFinal(companyName);
  if (cachedFinal) {
    return cachedFinal;
  }

  const llm = new ChatOpenAI({
    modelName: FINAL_MODEL,
    temperature: 0.25,
    maxTokens: 1100,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
    },
    apiKey: process.env.OPENROUTER_API_KEY,
  });

  const researchSteps: ResearchStep[] = [];
  const profileQuery = `${companyName} company overview business model competitors market position stock ticker`;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`AI research starting: ${companyName}`);
  console.log(`${"=".repeat(60)}\n`);

  const [profileEvidence, newsEvidence] = await Promise.all([
    searchWeb(profileQuery, { ttlMs: CACHE_TTL_MS.companyProfile, num: 4 }),
    searchNews(companyName),
  ]);

  researchSteps.push(step("web_search", { query: profileQuery }, profileEvidence));
  researchSteps.push(step("search_news", { companyName }, newsEvidence));

  const { symbol, financialEvidence, tickerEvidence } = await resolveFinancialData(
    companyName,
    profileEvidence,
    researchSteps
  );

  const evidencePacket = buildEvidencePacket({
    companyName,
    symbol,
    profileEvidence,
    tickerEvidence,
    financialEvidence,
    newsEvidence,
  });

  const response = await llm.invoke([
    new SystemMessage(SYNTHESIS_PROMPT),
    new HumanMessage(evidencePacket),
  ]);

  const output =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  const metrics: ResearchResult["optimizationMetrics"] = {
    llmCallsBeforeEstimate: 5,
    llmCallsAfter: 1,
    estimatedInputTokens: estimateTokens(SYNTHESIS_PROMPT + evidencePacket),
    cachedFinalAnalysis: false,
  };

  try {
    const parsed = parseJsonOutput(output);
    const result = coerceResearchResult(parsed, output, researchSteps, metrics);
    setCachedFinal(companyName, result);
    console.log(`\nVerdict: ${result.verdict} (${result.confidence})\n`);
    return result;
  } catch (parseError) {
    console.error("Failed to parse model output:", parseError);

    const fallback: ResearchResult = {
      verdict: output.toUpperCase().includes("INVEST") ? "INVEST" : "PASS",
      confidence: "LOW",
      summary: truncate(output, 500),
      reasoning: {
        strengths: ["See raw analysis"],
        risks: ["Could not parse structured output"],
        financialHealth: "See raw output",
        growthPotential: "See raw output",
        competitivePosition: "See raw output",
        recentDevelopments: "See raw output",
        investmentCommittee: "Could not parse structured committee reasoning.",
        whatWouldChangeOurView: ["A valid structured model response"],
      },
      researchSteps,
      rawOutput: output,
      error: "Output was not in expected JSON format",
      optimizationMetrics: metrics,
    };

    setCachedFinal(companyName, fallback);
    return fallback;
  }
}
