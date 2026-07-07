// lib/tools.ts
// Research data tools for company search, financial fundamentals, and recent news.
// Expensive external calls are cached with conservative TTLs so repeat analyses
// avoid unnecessary Serper and Alpha Vantage requests.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import axios from "axios";

const HOUR_MS = 60 * 60 * 1000;

export const CACHE_TTL_MS = {
  companyProfile: 24 * HOUR_MS,
  financialData: 24 * HOUR_MS,
  newsData: 45 * 60 * 1000,
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry<string>>();

function cacheKey(namespace: string, input: string): string {
  return `${namespace}:${input.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

async function getCached(
  namespace: string,
  input: string,
  ttlMs: number,
  loader: () => Promise<string>
): Promise<string> {
  const key = cacheKey(namespace, input);
  const cached = cache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = await loader();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function cleanText(value: unknown, maxLength = 360): string {
  const text = String(value || "N/A").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text;
}

function compactMetric(label: string, value: unknown): string {
  return `${label}: ${value || "N/A"}`;
}

export async function searchWeb(
  query: string,
  options: { ttlMs?: number; num?: number } = {}
): Promise<string> {
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS.companyProfile;
  const num = options.num ?? 4;

  return getCached("web", `${query}|${num}`, ttlMs, async () => {
    try {
      const response = await axios.post(
        "https://google.serper.dev/search",
        { q: query, num },
        {
          headers: {
            "X-API-KEY": process.env.SERPER_API_KEY!,
            "Content-Type": "application/json",
          },
        }
      );

      const results = response.data.organic || [];
      const formatted = results
        .slice(0, num)
        .map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (r: any, i: number) =>
            `${i + 1}. ${cleanText(r.title, 120)} | ${cleanText(r.snippet, 260)} | ${r.link || "N/A"}`
        )
        .join("\n");

      const kg = response.data.knowledgeGraph;
      const kgInfo = kg
        ? [
            `Quick facts: ${cleanText(kg.title, 80)} (${cleanText(kg.type, 80)})`,
            `Description: ${cleanText(kg.description, 320)}`,
            kg.attributes
              ? `Attributes: ${Object.entries(kg.attributes)
                  .slice(0, 6)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join("; ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n")
        : "";

      return [kgInfo, formatted].filter(Boolean).join("\n") || "No results found.";
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return `Search failed: ${msg}`;
    }
  });
}

export async function getFinancialData(symbol: string): Promise<string> {
  const normalizedSymbol = symbol.trim().toUpperCase();

  return getCached(
    "financial",
    normalizedSymbol,
    CACHE_TTL_MS.financialData,
    async () => {
      try {
        const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(
          normalizedSymbol
        )}&apikey=${process.env.ALPHA_VANTAGE_API_KEY}`;
        const response = await axios.get(url);
        const d = response.data;

        if (!d || d.Note || d.Information || !d.Symbol) {
          return `Could not find financial data for symbol: ${normalizedSymbol}. Try the primary exchange ticker, e.g. AAPL, MSFT, RELIANCE.BSE, TCS.BSE, INFY.`;
        }

        return [
          `Company: ${d.Name || "N/A"} (${d.Symbol || normalizedSymbol})`,
          `Sector: ${d.Sector || "N/A"}; Industry: ${d.Industry || "N/A"}; Exchange: ${d.Exchange || "N/A"}; Currency: ${d.Currency || "N/A"}`,
          [
            compactMetric("Market Cap", d.MarketCapitalization),
            compactMetric("P/E", d.PERatio),
            compactMetric("Forward P/E", d.ForwardPE),
            compactMetric("PEG", d.PEGRatio),
            compactMetric("Price/Book", d.PriceToBookRatio),
            compactMetric("EV/Revenue", d.EVToRevenue),
            compactMetric("EV/EBITDA", d.EVToEBITDA),
          ].join("; "),
          [
            compactMetric("EPS", d.EPS),
            compactMetric("Revenue TTM", d.RevenueTTM),
            compactMetric("Gross Profit TTM", d.GrossProfitTTM),
            compactMetric("Profit Margin", d.ProfitMargin),
            compactMetric("Operating Margin", d.OperatingMarginTTM),
            compactMetric("ROE", d.ReturnOnEquityTTM),
            compactMetric("ROA", d.ReturnOnAssetsTTM),
          ].join("; "),
          [
            compactMetric("Revenue Growth YoY", d.QuarterlyRevenueGrowthYOY),
            compactMetric("Earnings Growth YoY", d.QuarterlyEarningsGrowthYOY),
            compactMetric("Dividend Yield", d.DividendYield),
            compactMetric("52W High", d["52WeekHigh"]),
            compactMetric("52W Low", d["52WeekLow"]),
            compactMetric("Beta", d.Beta),
          ].join("; "),
          `Description: ${cleanText(d.Description, 420)}`,
        ].join("\n");
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        return `Financial data lookup failed: ${msg}`;
      }
    }
  );
}

export async function searchNews(companyName: string): Promise<string> {
  return getCached("news", companyName, CACHE_TTL_MS.newsData, async () => {
    try {
      const response = await axios.post(
        "https://google.serper.dev/news",
        { q: `${companyName} latest news business financial`, num: 5 },
        {
          headers: {
            "X-API-KEY": process.env.SERPER_API_KEY!,
            "Content-Type": "application/json",
          },
        }
      );

      const news = response.data.news || [];
      if (news.length === 0) return "No recent news found for this company.";

      return news
        .slice(0, 5)
        .map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (n: any, i: number) =>
            `${i + 1}. [${n.date || "Recent"}] ${cleanText(n.title, 120)} | ${cleanText(n.snippet, 240)} | ${n.source || "N/A"}`
        )
        .join("\n");
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return `News search failed: ${msg}`;
    }
  });
}

export const webSearchTool = tool(
  async ({ query }: { query: string }): Promise<string> => searchWeb(query),
  {
    name: "web_search",
    description:
      "Search the web for concise company overview, business model, competitors, market position, and relevant background information for investment analysis.",
    schema: z.object({
      query: z.string().describe("The search query to look up"),
    }),
  }
);

export const financialDataTool = tool(
  async ({ symbol }: { symbol: string }): Promise<string> =>
    getFinancialData(symbol),
  {
    name: "get_financial_data",
    description:
      "Get concise financial fundamentals and stock data for a company using its stock ticker symbol. Returns valuation, profitability, growth, trading metrics, and company description.",
    schema: z.object({
      symbol: z
        .string()
        .describe(
          "The stock ticker symbol, e.g. AAPL, MSFT, RELIANCE.BSE, TCS.BSE, INFY"
        ),
    }),
  }
);

export const newsSearchTool = tool(
  async ({ companyName }: { companyName: string }): Promise<string> =>
    searchNews(companyName),
  {
    name: "search_news",
    description:
      "Search for the latest company news. Returns the top 5 recent business or financial developments.",
    schema: z.object({
      companyName: z
        .string()
        .describe("The name of the company to search news for"),
    }),
  }
);
