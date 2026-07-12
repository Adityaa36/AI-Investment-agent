# Evident — AI Investment Research Agent

[![Live Demo](https://img.shields.io/badge/Live-Demo-success?style=for-the-badge)](https://ai-investment-agent-some8.vercel.app/)

Evident is an institutional-grade investment research agent built using Next.js (React 19), LangChain.js, OpenRouter, Alpha Vantage, and Google Serper. It acts as an automated investment research terminal, performing deep due diligence, evaluating fundamentals, scraping recent news, assessing risks, and synthesizing side-by-side company comparisons in under 60 seconds.

---

## Overview

Evident is designed to replicate the visual hierarchy and information density of a modern financial research terminal. Key capabilities include:

* **Single Research Mode:** Input any company name or ticker to generate an executive summary, portfolio safety scores, financial snapshot, bull/bear analyst committee notes, regulatory/market trigger lists, and a detailed tool trace showing the agent's research actions.
* **Side-by-Side Comparison Mode:** Compare two companies head-to-head. The agent retrieves financial details for both entities in parallel, ranks them, produces an overall decision rationale, and highlights winning/losing metrics (such as P/E Ratio, Revenue Growth, and ROE) in a comparative table.
* **Institutional Quality Presentation:** All large numbers are formatted professionally (e.g. $1.48T, $125B, $5.2B), decimals are converted to percentages (e.g. 15.8%), and P/E ratios are displayed using the standard x multiplier (e.g. 29.8x).
* **Interactive Multi-Step Progress Tracker:** Users can see the agent's exact real-time operations, including Serper searches, news evaluation, and financial overview fetching.
* **Exportable PDF Report:** Generates formatted PDF investment memos directly from the dashboard.

---

## Live Demo

The project is publicly deployed on **Vercel** and can be accessed here:

**Live Application:** https://ai-investment-agent-some8.vercel.app/

Feel free to explore the application and test the AI Investment Research Agent directly without any local setup.

---

## Landing Page Interface

The home interface leverages clean spacing, modern typography, a faint dot grid overlay, and subtle radial gradient lights. An animated background chart draws itself on load, surrounded by floating ticker status widgets.

<img src="docs/screenshots/landing-page.png" alt="Evident Landing Page" width="1000"/>

*Evident landing page featuring the institutional search bar, quick ticker shortcuts, and a prominent link to comparison mode.*

---

## Installation and Setup

### 1. Prerequisites
* **Node.js:** v20.x or higher
* **npm:** v10.x or higher

### 2. Clone the Repository
```bash
git clone https://github.com/Adityaa36/AI-Investment-agent.git
cd AI-Investment-agent
```

### 3. Configure Environment Variables
Create a `.env.local` file in the root directory and add the following keys:

```env
# OpenRouter API Key for LLM execution (uses google/gemini-2.5-flash)
OPENROUTER_API_KEY=your_openrouter_api_key_here

# Google Serper API Key for real-time web search and news fallbacks
SERPER_API_KEY=your_serper_api_key_here

# Alpha Vantage API Key for fetching official financial overview and fundamentals
ALPHA_VANTAGE_API_KEY=your_alpha_vantage_api_key_here
```

### 4. Install Dependencies
Run the installation command (a `.npmrc` is included with `legacy-peer-deps=true` to automatically bypass peer dependency conflicts in Next.js environments):
```bash
npm install
```

### 5. Run the Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### 6. Build for Production
```bash
npm run build
npm run start
```

---

## System Architecture and Data Flow

Evident implements a deterministic evidence-gathering pipeline followed by an LLM-based synthesis loop to remain fast, predictable, and extremely token-efficient:

```mermaid
graph TD
    A[User Input / Ticker Name] --> B[Parallel Web Search & News Retrieval]
    B --> C[Ticker Resolution / Ticker Mapping]
    C --> D[Alpha Vantage Financial Fetching]
    D -->|Failure / Non-US Ticker| E[Fallback Web Scraping & Serper Parser]
    D -->|Success| F[Evidence Packet Aggregator]
    E --> F
    F --> G[LangChain ChatOpenAI LLM Synthesis google/gemini-2.5-flash]
    G --> H[Structured JSON Analysis Output]
    H --> I[React Frontend Presentation Terminal]
```

### Process Breakdown:
1. **Parallel Pre-fetching:** Upon receiving a query, Serper pulls the company's business model overview and recent news concurrently to save round-trip time.
2. **Ticker Resolution:** Ticker candidates are derived from the web overview (e.g. "TCS" -> "TCS.BSE").
3. **Financial Retrieval with Failover:** Alpha Vantage is queried for the overview details. If it fails (e.g. for non-US listings like Zomato or TCS), Evident triggers a secondary fallback pipeline that parses Google Search content to locate the current valuation metrics.
4. **LLM Synthesis:** The gathered raw metrics, news snippets, and overview text are packed together and sent to google/gemini-2.5-flash in a single pass to produce a structured JSON response containing the verdict, safety scores, strengths, and risks.

---

## Key Decisions & Trade-offs

* **Deterministic Pipeline vs. Iterative Agent Loops:** 
  * *Decision:* The agent uses a structured pre-fetching logic rather than letting the LLM recursively call tools in a loop.
  * *Trade-off:* While it restricts the LLM from executing arbitrary tool chains, it cuts token usage by over 80%, decreases search times from 40s+ to under 10s, and guarantees predictable results with no infinite-loop risks.
* **Tailwind CSS vs. Custom Semantic CSS:** 
  * *Decision:* Opted for a premium, highly tailored vanilla CSS layout in globals.css with structured variables.
  * *Trade-off:* Avoids class-name clutter, ensures maximum visual flexibility for complex micro-animations (such as drawing the SVG grid and chart), and keeps page weight tiny.
* **OpenRouter Gateway:**
  * *Decision:* Utilizes OpenRouter for model routing.
  * *Trade-off:* Easily allows switching the underlying synthesis model (e.g. from Gemini to Claude or GPT-4) without changing codebase integrations.

---

## Example Runs and Visual Outputs

### Example 1: Single Research Mode – Apple Inc.

#### Prompt
> Analyze Apple as a long-term investment. Include business overview, financial health, valuation, risks, catalysts, and provide a committee-style investment recommendation.

#### Output

<img src="docs/screenshots/apple-overview.png" alt="Apple Analysis Overview" width="900"/>

*Executive Summary and Financial Snapshot dashboard displaying parsed fundamental metrics (e.g., Market Cap of $4.63T and a P/E Ratio of 38.2x) alongside the Bull and Bear Thesis commentary.*

<img src="docs/screenshots/apple-investment-view.png" alt="Apple Investment view" width="900"/>

*Analyst Committee Discussion panel presenting detailed upgrade/risk triggers and specific qualitative reports for both Bull and Bear analyst models.*

<img src="docs/screenshots/apple-financial-analysis.png" alt="Apple Financial analysis" width="900"/>

*Detailed Fundamental Analysis panel assessing long-term competitive position and growth potential, accompanied by structural portfolio suitability scores.*

<img src="docs/screenshots/apple-conclusion.png" alt="Apple Export Preview" width="900"/>

*PDF Memo generation preview illustrating the print-ready, clean document formatting that can be exported directly from the dashboard.*

---

### Example 2: Side-by-Side Comparison Mode

#### Prompt
> Compare Tata Consultancy Services (TCS) and Infosys head-to-head. Compare their key metrics and provide a verdict on which company is the stronger investment pick.

#### Output

<img src="docs/screenshots/company-comparison.png" alt="Company Comparison" width="900"/>

*Head-to-head metrics comparison displaying winning (green), tied (amber), or losing cells for both target companies side-by-side.*

---

## Future Improvements

* **Vector-based Search (RAG):** Indexing company PDFs, annual reports (10-K/10-Q), and investor presentations to extract deep balance sheet commentary.
* **Historical Price Charts:** Integrating TradingView or lightweight Recharts graphs to display historical equity performance inside the Snapshot panel.
* **Mock Portfolio Tracker:** Letting users build hypothetical portfolios based on AI recommendations and monitor paper performance over time.
* **OAuth & DB Persistence:** Saving user search history and keeping track of previous comparisons.

---

## Assignment Transcript Logs

For evaluation and bonus points, the full history of conversation transcripts detailing the pair programming development of this project with the LLM is included within the repository at:
* **Directory Path:** docs/llm-chat-logs/transcript.jsonl
*(Contains exact prompts, tool calls, and thinking processes from start to finish)*
