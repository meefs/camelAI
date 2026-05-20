type WebProvider = "firecrawl" | "parallel" | "exa";

interface CodeModeWebSearchEnv {
  APP_KV: KVNamespace;
  FIRECRAWL_API_KEY?: string;
  FIRECRAWL_BASE_URL?: string;
  PARALLEL_API_KEY?: string;
  PARALLEL_BASE_URL?: string;
  EXA_API_KEY?: string;
  EXA_BASE_URL?: string;
  WEB_PROVIDER_ORDER?: string;
  CHIRIDION_WEB_PROVIDER_ORDER?: string;
}

interface WebResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  snippet?: string;
  text?: string;
}

interface WebProviderResult {
  provider: WebProvider;
  results: WebResult[];
  costUSD: number;
}

const WEB_PROVIDER_DEFAULT_ORDER: WebProvider[] = ["firecrawl", "parallel", "exa"];
const WEB_PROVIDER_ROUND_ROBIN_KEY = "code-mode:web-provider:index";
const WEB_PROVIDER_TIMEOUT_MS = 20_000;

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function truncateText(value: unknown, maxCharacters: number): string {
  const text = String(value ?? "");
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, maxCharacters)}\n\n[Truncated: ${maxCharacters} of ${text.length} characters]`;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

function boolParam(params: Record<string, unknown>, key: string): boolean {
  return params[key] === true;
}

function defaultString(value: string, fallback: string): string {
  return value.trim() ? value : fallback;
}

function contentString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(contentString).map((text) => text.trim()).filter(Boolean).join("\n\n");
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function firstString(values: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (!values) return "";
  for (const key of keys) {
    const text = contentString(values[key]).trim();
    if (text) return text;
  }
  return "";
}

function firstContent(values: Record<string, unknown>, ...keys: string[]): string {
  return firstString(values, ...keys);
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function payloadMessage(payload: Record<string, unknown>): string {
  const error = payload.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  const message = payload.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  return "unknown error";
}

function normalizeDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    let domain = String(entry ?? "").trim();
    if (!domain) continue;
    if (!domain.includes("://")) domain = `https://${domain}`;
    try {
      const parsed = new URL(domain);
      if (parsed.hostname) domain = parsed.hostname;
    } catch {
      // Keep the caller-provided value and normalize below.
    }
    domain = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
    if (domain) out.push(domain);
    if (out.length >= 20) break;
  }
  return out;
}

function anyDomainMatches(hostname: string, domains: string[]): boolean {
  return domains.some((domain) => {
    const normalized = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

function filterDomains(results: WebResult[], includeDomains: string[], excludeDomains: string[]): WebResult[] {
  return results.filter((result) => {
    if (!result.url) return false;
    let hostname = "";
    try {
      hostname = new URL(result.url).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (includeDomains.length > 0 && !anyDomainMatches(hostname, includeDomains)) return false;
    if (anyDomainMatches(hostname, excludeDomains)) return false;
    return true;
  });
}

function dateOnly(value: unknown): string {
  const match = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[0] : "";
}

function firecrawlDate(date: string): string {
  const parts = date.split("-");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}/${parts[0]}` : date;
}

function parallelUsageCostUSD(payload: Record<string, unknown>): number {
  if (!Array.isArray(payload.usage)) return 0;
  let total = 0;
  for (const entry of payload.usage) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const count = numberValue(item.count) ?? 1;
    switch (String(item.name ?? "").trim()) {
      case "sku_search":
        total += count * 0.005;
        break;
      case "sku_extract_excerpts":
      case "sku_extract_full_content":
        total += count * 0.001;
        break;
    }
  }
  return total;
}

function exaCostUSD(payload: Record<string, unknown>): number {
  const cost = payload.costDollars;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return 0;
  return numberValue((cost as Record<string, unknown>).total) ?? 0;
}

function normalizeFirecrawlResult(entry: unknown, includeContent: boolean): WebResult | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const item = entry as Record<string, unknown>;
  const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
    ? item.metadata as Record<string, unknown>
    : undefined;
  const targetURL = firstString(item, "url", "sourceURL") || firstString(metadata, "sourceURL", "url");
  if (!targetURL) return null;
  const result: WebResult = {
    title: defaultString(firstString(item, "title"), firstString(metadata, "title", "ogTitle")),
    url: targetURL,
    publishedDate: defaultString(
      firstString(item, "publishedDate", "published_date", "date"),
      firstString(metadata, "publishedDate", "publishedTime", "date"),
    ),
    author: defaultString(firstString(item, "author"), firstString(metadata, "author")),
    snippet: firstContent(item, "description", "snippet"),
  };
  if (includeContent) {
    result.text = firstContent(item, "markdown", "text", "summary", "content") || result.snippet;
  }
  return result;
}

function firecrawlEntries(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.data)) return payload.data;
  if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) return [];
  const data = payload.data as Record<string, unknown>;
  return ["web", "news", "images"].flatMap((key) => Array.isArray(data[key]) ? data[key] as unknown[] : []);
}

function normalizeParallelResults(value: unknown, includeContent: boolean): WebResult[] {
  if (!Array.isArray(value)) return [];
  const results: WebResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const targetURL = firstString(item, "url");
    if (!targetURL) continue;
    results.push({
      title: firstString(item, "title"),
      url: targetURL,
      publishedDate: firstString(item, "publish_date", "publishedDate", "published_date"),
      snippet: firstContent(item, "description", "snippet", "excerpts"),
      text: includeContent ? defaultString(contentString(item.full_content), contentString(item.excerpts)) : "",
    });
  }
  return results;
}

function normalizeExaResults(value: unknown, includeContent: boolean): WebResult[] {
  if (!Array.isArray(value)) return [];
  const results: WebResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const targetURL = firstString(item, "url");
    if (!targetURL) continue;
    results.push({
      title: firstString(item, "title"),
      url: targetURL,
      publishedDate: firstString(item, "publishedDate"),
      author: firstString(item, "author"),
      snippet: firstContent(item, "snippet", "description", "highlights"),
      text: includeContent ? firstContent(item, "text", "summary", "highlights") : "",
    });
  }
  return results;
}

function truncateResultText(text: unknown, maxCharacters: number): string {
  return truncateText(String(text ?? "").trim(), maxCharacters).trim();
}

function truncateResults(results: WebResult[], limit: number, maxCharacters: number): WebResult[] {
  return results.slice(0, Math.max(0, limit)).map((result) => ({
    ...result,
    snippet: truncateResultText(result.snippet, maxCharacters),
    text: truncateResultText(result.text, maxCharacters),
  }));
}

function formatResults(results: WebResult[], maxCharacters: number, empty: string): string {
  if (results.length === 0) return empty;
  return results.map((result, index) => {
    const lines = [`${index + 1}. ${result.title?.trim() || "Untitled"}`];
    if (result.url) lines.push(`URL: ${result.url}`);
    if (result.publishedDate) lines.push(`Published: ${result.publishedDate}`);
    if (result.author) lines.push(`Author: ${result.author}`);
    const snippet = truncateResultText(result.snippet, maxCharacters);
    if (snippet) lines.push(`Snippet: ${snippet}`);
    const text = truncateResultText(result.text, maxCharacters);
    if (text) lines.push("", text);
    return lines.join("\n");
  }).join("\n\n");
}

export class CodeModeWebSearch {
  constructor(
    private readonly env: CodeModeWebSearchEnv,
    private readonly sessionId: string,
  ) {}

  async search(args: Record<string, unknown>): Promise<unknown> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) throw new Error("query is required");
    const numResults = clampInteger(args.numResults, 5, 1, 10);
    const maxCharacters = clampInteger(args.maxCharacters, 1200, 200, 8000);
    const providerResult = await this.withProviderFallback("search", (provider) =>
      this.searchWithProvider(provider, args, query, numResults, maxCharacters)
    );
    const text = formatResults(
      providerResult.results,
      maxCharacters,
      `No results found for ${query}.`,
    );
    return {
      content: [{ type: "text", text }],
      costUSD: providerResult.costUSD,
      provider: providerResult.provider,
      results: providerResult.results,
      success: true,
      query,
      text,
    };
  }

  async fetch(args: Record<string, unknown>): Promise<unknown> {
    const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
    if (!rawUrl) throw new Error("url is required");
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only http and https URLs are supported");
    }
    const maxCharacters = clampInteger(args.maxCharacters, 12_000, 500, 30_000);
    const providerResult = await this.withProviderFallback("fetch", (provider) =>
      this.fetchWithProvider(provider, args, url.toString(), maxCharacters)
    );
    const text = formatResults(
      providerResult.results,
      maxCharacters,
      `No content returned for ${url.toString()}.`,
    );
    return {
      content: [{ type: "text", text }],
      costUSD: providerResult.costUSD,
      provider: providerResult.provider,
      results: providerResult.results,
      success: true,
      url: url.toString(),
      text,
    };
  }

  private providerBaseURL(provider: WebProvider): string {
    switch (provider) {
      case "firecrawl":
        return (this.env.FIRECRAWL_BASE_URL || "https://api.firecrawl.dev").replace(/\/+$/, "");
      case "parallel":
        return (this.env.PARALLEL_BASE_URL || "https://api.parallel.ai").replace(/\/+$/, "");
      case "exa":
        return (this.env.EXA_BASE_URL || "https://api.exa.ai").replace(/\/+$/, "");
    }
  }

  private providerAPIKey(provider: WebProvider): string {
    switch (provider) {
      case "firecrawl":
        return (this.env.FIRECRAWL_API_KEY || "").trim();
      case "parallel":
        return (this.env.PARALLEL_API_KEY || "").trim();
      case "exa":
        return (this.env.EXA_API_KEY || "").trim();
    }
  }

  private async withProviderFallback(
    operation: "search" | "fetch",
    call: (provider: WebProvider) => Promise<WebProviderResult>,
  ): Promise<WebProviderResult> {
    const configuredOrder = (this.env.WEB_PROVIDER_ORDER || this.env.CHIRIDION_WEB_PROVIDER_ORDER || "firecrawl,parallel,exa")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value): value is WebProvider => value === "firecrawl" || value === "parallel" || value === "exa");
    const preferred = [...configuredOrder];
    for (const provider of WEB_PROVIDER_DEFAULT_ORDER) {
      if (!preferred.includes(provider)) preferred.push(provider);
    }
    const providers: WebProvider[] = [];
    for (const provider of preferred) {
      if (!providers.includes(provider) && this.providerAPIKey(provider) !== "") providers.push(provider);
    }
    if (providers.length > 1) {
      let start = 0;
      try {
        const raw = await this.env.APP_KV.get(WEB_PROVIDER_ROUND_ROBIN_KEY);
        const parsed = Number.parseInt(raw || "0", 10);
        start = Number.isFinite(parsed) ? parsed % providers.length : 0;
        await this.env.APP_KV.put(WEB_PROVIDER_ROUND_ROBIN_KEY, String(start + 1));
      } catch (error) {
        console.warn("Failed to update web provider round robin index", error);
      }
      providers.splice(0, providers.length, ...providers.slice(start), ...providers.slice(0, start));
    }
    if (providers.length === 0) {
      throw new Error("no web provider API keys are configured");
    }
    const failures: string[] = [];
    for (const provider of providers) {
      try {
        return await call(provider);
      } catch (error) {
        failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`${operation} failed for all web providers: ${failures.join("; ")}`);
  }

  private async json(
    provider: WebProvider,
    target: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEB_PROVIDER_TIMEOUT_MS);
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let payload: Record<string, unknown> = {};
      if (raw.trim()) {
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          payload = { message: raw.slice(0, 4096) };
        }
      }
      if (!response.ok) {
        throw new Error(`${provider} request failed with HTTP ${response.status}: ${payloadMessage(payload)}`);
      }
      if (payload.success === false) {
        throw new Error(`${provider} request failed: ${payloadMessage(payload)}`);
      }
      return payload;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async searchWithProvider(
    provider: WebProvider,
    args: Record<string, unknown>,
    query: string,
    numResults: number,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    switch (provider) {
      case "firecrawl":
        return this.firecrawlSearch(args, query, numResults, maxCharacters);
      case "parallel":
        return this.parallelSearch(args, query, numResults, maxCharacters);
      case "exa":
        return this.exaSearch(args, query, numResults, maxCharacters);
    }
  }

  private async fetchWithProvider(
    provider: WebProvider,
    args: Record<string, unknown>,
    targetURL: string,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    switch (provider) {
      case "firecrawl":
        return this.firecrawlFetch(args, targetURL, maxCharacters);
      case "parallel":
        return this.parallelFetch(args, targetURL, maxCharacters);
      case "exa":
        return this.exaFetch(args, targetURL, maxCharacters);
    }
  }

  private async firecrawlSearch(
    args: Record<string, unknown>,
    query: string,
    numResults: number,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const includeDomains = normalizeDomains(args.includeDomains);
    const excludeDomains = normalizeDomains(args.excludeDomains);
    const category = String(args.category ?? "").trim();
    const queryParts = [query];
    if (category === "pdf") queryParts.push("filetype:pdf");
    if (includeDomains.length === 1) queryParts.push(`site:${includeDomains[0]}`);
    for (const domain of excludeDomains) queryParts.push(`-site:${domain}`);
    const body: Record<string, unknown> = {
      query: queryParts.join(" "),
      limit: numResults,
      sources: category === "news" ? ["web", "news"] : ["web"],
      ignoreInvalidURLs: true,
      timeout: 30000,
    };
    switch (category) {
      case "github":
        body.categories = ["github"];
        break;
      case "pdf":
        body.categories = ["pdf"];
        break;
      case "research paper":
        body.categories = ["research"];
        break;
    }
    const startDate = dateOnly(args.startPublishedDate);
    const endDate = dateOnly(args.endPublishedDate);
    if (startDate || endDate) {
      const tbs = ["cdr:1"];
      if (startDate) tbs.push(`cd_min:${firecrawlDate(startDate)}`);
      if (endDate) tbs.push(`cd_max:${firecrawlDate(endDate)}`);
      body.tbs = tbs.join(",");
    }
    const payload = await this.json("firecrawl", `${this.providerBaseURL("firecrawl")}/v2/search`, {
      authorization: `Bearer ${this.providerAPIKey("firecrawl")}`,
    }, body);
    const results = firecrawlEntries(payload)
      .map((entry) => normalizeFirecrawlResult(entry, false))
      .filter((result): result is WebResult => result !== null);
    return {
      provider: "firecrawl",
      results: truncateResults(filterDomains(results, includeDomains, excludeDomains), numResults, maxCharacters),
      costUSD: 0.005,
    };
  }

  private async firecrawlFetch(
    args: Record<string, unknown>,
    targetURL: string,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const payload = await this.json("firecrawl", `${this.providerBaseURL("firecrawl")}/v2/scrape`, {
      authorization: `Bearer ${this.providerAPIKey("firecrawl")}`,
    }, {
      url: targetURL,
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 30000,
      maxAge: boolParam(args, "fresh") ? 0 : 172800000,
    });
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? { ...(payload.data as Record<string, unknown>), url: targetURL }
      : { ...payload, url: targetURL };
    const result = normalizeFirecrawlResult(data, true);
    return {
      provider: "firecrawl",
      results: result ? truncateResults([result], 1, maxCharacters) : [],
      costUSD: 0.001,
    };
  }

  private async parallelSearch(
    args: Record<string, unknown>,
    query: string,
    numResults: number,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const includeDomains = normalizeDomains(args.includeDomains);
    const excludeDomains = normalizeDomains(args.excludeDomains);
    const sourcePolicy: Record<string, unknown> = {};
    if (includeDomains.length) sourcePolicy.include_domains = includeDomains;
    if (excludeDomains.length) sourcePolicy.exclude_domains = excludeDomains;
    const afterDate = dateOnly(args.startPublishedDate);
    if (afterDate) sourcePolicy.after_date = afterDate;
    const advanced: Record<string, unknown> = { max_results: numResults };
    if (Object.keys(sourcePolicy).length) advanced.source_policy = sourcePolicy;
    const payload = await this.json("parallel", `${this.providerBaseURL("parallel")}/v1/search`, {
      "x-api-key": this.providerAPIKey("parallel"),
    }, {
      objective: query,
      search_queries: [query],
      mode: String(args.searchType ?? "").trim() === "fast" ? "basic" : "advanced",
      max_chars_total: Math.max(1000, numResults * maxCharacters),
      session_id: this.sessionId,
      advanced_settings: advanced,
    });
    const costUSD = parallelUsageCostUSD(payload) || 0.005;
    return {
      provider: "parallel",
      results: truncateResults(
        filterDomains(normalizeParallelResults(payload.results, false), includeDomains, excludeDomains),
        numResults,
        maxCharacters,
      ),
      costUSD,
    };
  }

  private async parallelFetch(
    args: Record<string, unknown>,
    targetURL: string,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const objective = stringParam(args, "query") || `Extract the main content from ${targetURL}.`;
    const payload = await this.json("parallel", `${this.providerBaseURL("parallel")}/v1/extract`, {
      "x-api-key": this.providerAPIKey("parallel"),
    }, {
      urls: [targetURL],
      objective,
      max_chars_total: maxCharacters,
      session_id: this.sessionId,
      advanced_settings: {
        fetch_policy: {
          max_age_seconds: boolParam(args, "fresh") ? 600 : 172800,
          timeout_seconds: 30,
          disable_cache_fallback: false,
        },
        excerpt_settings: { max_chars_per_result: Math.max(1000, Math.min(maxCharacters, 30000)) },
        full_content: { max_chars_per_result: maxCharacters },
      },
    });
    const results = normalizeParallelResults(payload.results, true);
    if (results.length === 0 && Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error("parallel extract returned errors");
    }
    return {
      provider: "parallel",
      results: truncateResults(results, 1, maxCharacters),
      costUSD: parallelUsageCostUSD(payload) || 0.001,
    };
  }

  private async exaSearch(
    args: Record<string, unknown>,
    query: string,
    numResults: number,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const body: Record<string, unknown> = {
      query,
      type: stringParam(args, "searchType") || "auto",
      numResults,
    };
    for (const key of ["category", "startPublishedDate", "endPublishedDate"] as const) {
      const value = stringParam(args, key);
      if (value) body[key] = value;
    }
    const includeDomains = normalizeDomains(args.includeDomains);
    const excludeDomains = normalizeDomains(args.excludeDomains);
    if (includeDomains.length) body.includeDomains = includeDomains;
    if (excludeDomains.length) body.excludeDomains = excludeDomains;
    const payload = await this.json("exa", `${this.providerBaseURL("exa")}/search`, {
      "x-api-key": this.providerAPIKey("exa"),
    }, body);
    return {
      provider: "exa",
      results: truncateResults(normalizeExaResults(payload.results, false), numResults, maxCharacters),
      costUSD: exaCostUSD(payload) || 0.007,
    };
  }

  private async exaFetch(
    args: Record<string, unknown>,
    targetURL: string,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const body: Record<string, unknown> = {
      urls: [targetURL],
      livecrawl: boolParam(args, "fresh") ? "always" : "fallback",
      livecrawlTimeout: 15000,
    };
    switch (stringParam(args, "content")) {
      case "highlights": {
        const highlights: Record<string, unknown> = { numSentences: 4, highlightsPerUrl: 5 };
        const query = stringParam(args, "query");
        if (query) highlights.query = query;
        body.highlights = highlights;
        break;
      }
      case "summary": {
        const query = stringParam(args, "query");
        body.summary = query ? { query } : {};
        break;
      }
      default:
        body.text = { maxCharacters };
    }
    const payload = await this.json("exa", `${this.providerBaseURL("exa")}/contents`, {
      "x-api-key": this.providerAPIKey("exa"),
    }, body);
    return {
      provider: "exa",
      results: truncateResults(normalizeExaResults(payload.results, true), 1, maxCharacters),
      costUSD: exaCostUSD(payload) || 0.001,
    };
  }
}
