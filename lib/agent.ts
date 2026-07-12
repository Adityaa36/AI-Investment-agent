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

const SYNTHESIS_PROMPT = `You are an institutional investment analyst. Produce a concise, high-signal investment recommendation from the provided evidence packet.

## Evidence Packet:
The evidence packet contains web search results, financial data, and news. 
If the Alpha Vantage financial database did not contain the ticker, the packet will contain web search fallback results under "Financial metrics". You MUST extract the metrics (P/E ratio, market cap, profit margin, revenue growth, debt-to-equity) from these search results. Do not leave them as "N/A" if they are present in the web search results!

## Formatting Rules:
When outputting financial numbers in the JSON (marketCap, peRatio, revenueGrowth, profitMargin, debtToEquity), ALWAYS prefer raw machine-readable numeric formats (e.g. raw numbers like 4718977352000 instead of "4.72T", 0.158 instead of "15.8%", 0.0395 instead of "3.95%", 0.73 instead of "0.73", 29.8 instead of "29.8x") so that the client application can parse and format them.

Return ONLY valid JSON with this exact shape:
{
  "verdict": "INVEST" or "PASS",
  "confidence": "HIGH" or "MEDIUM" or "LOW",
  "summary": "2-3 concise sentences with recommendation and core reason",
  "highlights": {
    "companyOverview": "1 concise paragraph, no more than 70 words",
    "sector": "sector or N/A",
    "marketCap": "raw numeric value (e.g. 1500000000000) or N/A",
    "stockTicker": "ticker used or N/A"
  },
  "reasoning": {
    "strengths": ["strongest bull point 1 with numbers when available", "strongest bull point 2", "strongest bull point 3"],
    "risks": ["strongest bear point 1", "strongest bear point 2", "strongest bear point 3"],
    "financialHealth": "1-2 concise sentences summarizing the financial position",
    "growthPotential": "1-2 concise sentences on TAM and prospects",
    "competitivePosition": "1-2 concise sentences on market share and moat",
    "recentDevelopments": "1-2 concise sentences using top news only"
  },
  "keyMetrics": {
    "peRatio": "raw numeric value (e.g. 29.8) or N/A",
    "revenueGrowth": "raw decimal ratio (e.g. 0.158) or N/A",
    "profitMargin": "raw decimal ratio (e.g. 0.184) or N/A",
    "debtToEquity": "raw decimal ratio (e.g. 0.73) or N/A"
  },
  "analystNote": "1-2 concise sentences on the key swing factor"
}`;

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

  // Fallback to Google Search for key financials if Alpha Vantage fails
  console.log(`Financial data not found for ${companyName} via Alpha Vantage. Performing web search fallback...`);
  const query1 = `${companyName} stock valuation metrics PE ratio market cap Yahoo Finance`;
  const query2 = `${companyName} stock profit margin revenue growth debt to equity Moneycontrol Yahoo Finance`;
  
  const [search1, search2] = await Promise.all([
    searchWeb(query1, { ttlMs: CACHE_TTL_MS.companyProfile, num: 4 }),
    searchWeb(query2, { ttlMs: CACHE_TTL_MS.companyProfile, num: 4 }),
  ]);
  
  researchSteps.push(step("web_search", { query: query1 }, search1));
  researchSteps.push(step("web_search", { query: query2 }, search2));
  
  // Format the web search results so the LLM knows it is the fallback evidence
  lastFinancialEvidence = `[WEB SEARCH FALLBACK - Alpha Vantage database did not contain this ticker. The following is web search results for the financial metrics of ${companyName}:]\n\n--- Source 1 (Valuation) ---\n${search1}\n\n--- Source 2 (Growth & Ratios) ---\n${search2}`;

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
  // Defensive extraction of keyMetrics if nested inside reasoning
  let keyMetrics = parsed.keyMetrics as ResearchResult["keyMetrics"];
  if (!keyMetrics && parsed.reasoning && typeof parsed.reasoning === "object") {
    const r = parsed.reasoning as Record<string, unknown>;
    if (r.keyMetrics && typeof r.keyMetrics === "object") {
      keyMetrics = r.keyMetrics as ResearchResult["keyMetrics"];
      delete r.keyMetrics;
    }
  }

  // Defensive extraction of highlights if nested inside reasoning
  let highlights = parsed.highlights as ResearchResult["highlights"];
  if (!highlights && parsed.reasoning && typeof parsed.reasoning === "object") {
    const r = parsed.reasoning as Record<string, unknown>;
    if (r.highlights && typeof r.highlights === "object") {
      highlights = r.highlights as ResearchResult["highlights"];
      delete r.highlights;
    }
  }

  // Set default values for keyMetrics if missing
  const defaultMetrics = {
    peRatio: "N/A",
    revenueGrowth: "N/A",
    profitMargin: "N/A",
    debtToEquity: "N/A",
    ...(keyMetrics || {})
  };

  // Set default values for highlights if missing
  const defaultHighlights = {
    companyOverview: "",
    sector: "N/A",
    marketCap: "N/A",
    stockTicker: "N/A",
    ...(highlights || {})
  };

  return {
    verdict: String(parsed.verdict || "PASS"),
    confidence: String(parsed.confidence || "LOW"),
    summary: String(parsed.summary || ""),
    highlights: defaultHighlights,
    reasoning: parsed.reasoning as ResearchResult["reasoning"],
    keyMetrics: defaultMetrics,
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
