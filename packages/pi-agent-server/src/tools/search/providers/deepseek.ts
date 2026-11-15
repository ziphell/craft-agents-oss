/**
 * DeepSeek search provider — uses DeepSeek's own search tool API.
 *
 * Docs: https://api-docs.deepseek.com/zh-cn/guides/search
 * Billed per successful request (5 CNY / 1000), not per token or result.
 */

import type { WebSearchProvider, WebSearchResult } from '../types.ts';

const SEARCH_URL = 'https://api.deepseek.com/v1/tools/search';

interface DeepSeekSearchResult {
  title?: string;
  url?: string;
  /** Long summary (~600–800 chars), meant to be read by a model. */
  summary?: string;
  /** Short summary (~100–200 chars), meant for display. */
  snippet?: string;
}

export class DeepSeekSearchProvider implements WebSearchProvider {
  name = 'DeepSeek';

  constructor(private apiKey: string) {}

  async search(query: string, count: number): Promise<WebSearchResult[]> {
    const response = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query, count }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek Search failed (HTTP ${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { results?: DeepSeekSearchResult[] };
    return (data.results ?? [])
      .filter((result) => result.url)
      .slice(0, count)
      .map((result) => ({
        title: result.title || result.url!,
        url: result.url!,
        description: result.summary || result.snippet || '',
      }));
  }
}
