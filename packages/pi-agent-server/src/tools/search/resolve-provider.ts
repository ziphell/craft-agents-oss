/**
 * Resolves the best web search provider based on the user's LLM connection.
 *
 * Priority:
 *   1. Provider-native search (OpenAI, ChatGPT, OpenRouter, Google) — best quality
 *   2. DuckDuckGo — universal fallback, no API key required
 *
 * To add a new Responses API-compatible provider:
 *   1. Add a case here with the provider name and apiBase URL
 *   2. The ResponsesApiSearchProvider handles the rest
 */

import type { WebSearchProvider } from './types.ts';
import type { WebSearchProviderPreference } from '../../../../shared/src/config/types.ts';
import { ResponsesApiSearchProvider } from './providers/openai.ts';
import { ChatGPTBackendSearchProvider, extractChatGptAccountId } from './providers/chatgpt.ts';
import { GoogleSearchProvider } from './providers/google.ts';
import { DeepSeekSearchProvider } from './providers/deepseek.ts';
import { DDGSearchProvider } from './providers/ddg.ts';

export type SearchProviderCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number }
  | { type: string; key?: string; access?: string };

export interface SearchProviderAuthConfig {
  provider?: string;
  credential?: SearchProviderCredential;
}

function getApiKey(piAuth?: SearchProviderAuthConfig): string | undefined {
  if (piAuth?.credential?.type !== 'api_key') return undefined;
  return typeof piAuth.credential.key === 'string' && piAuth.credential.key.length > 0
    ? piAuth.credential.key
    : undefined;
}

function getOAuthAccess(piAuth?: SearchProviderAuthConfig): string | undefined {
  if (piAuth?.credential?.type !== 'oauth') return undefined;
  const access = (piAuth.credential as { access?: string }).access;
  return typeof access === 'string' && access.length > 0 ? access : undefined;
}

/**
 * openai-codex tokens may arrive as either:
 *  - oauth.access (legacy/explicit oauth shape), or
 *  - api_key.key (current runtime shape for ChatGPT Plus OAuth bearer token)
 */
function getOpenAiCodexAccessToken(piAuth?: SearchProviderAuthConfig): string | undefined {
  if (piAuth?.provider !== 'openai-codex') return undefined;
  return getOAuthAccess(piAuth) ?? getApiKey(piAuth);
}

/**
 * @param activeModel Bare (no `pi/` prefix) model ID of the active session/connection. Used
 *   by the ChatGPT backend provider to search with a model the account actually supports,
 *   instead of a hardcoded one that may have been retired (craft-agents-oss#1023).
 * @param preferred Service chosen in Settings → AI. `auto` follows the active connection and
 *   falls back to DuckDuckGo; `duckduckgo` and `deepseek` name a service explicitly.
 * @param deepSeekSearchKey Key stored for the explicit DeepSeek choice. When absent, search
 *   stays on the free DuckDuckGo rather than failing.
 */
export function resolveSearchProvider(
  piAuth?: SearchProviderAuthConfig,
  activeModel?: string,
  preferred: WebSearchProviderPreference = 'auto',
  deepSeekSearchKey?: string,
): WebSearchProvider {
  const provider = piAuth?.provider;
  const apiKey = getApiKey(piAuth);
  const openAiCodexAccess = getOpenAiCodexAccessToken(piAuth);

  // OpenAI with API key → standard Responses API
  const openAiSearch = (): WebSearchProvider | undefined => {
    if (provider !== 'openai' || !apiKey) return undefined;
    return new ResponsesApiSearchProvider({
      apiBase: 'https://api.openai.com/v1',
      apiKey,
    });
  };

  // ChatGPT Plus (OpenAI OAuth bearer token) → ChatGPT backend endpoint
  // Supports both oauth.access and api_key.key token shapes.
  const chatGptSearch = (): WebSearchProvider | undefined => {
    if (provider !== 'openai-codex' || !openAiCodexAccess) return undefined;
    const accountId = extractChatGptAccountId(openAiCodexAccess);
    // Can't extract accountId (malformed/non-JWT token) → not usable
    if (!accountId) return undefined;
    return new ChatGPTBackendSearchProvider(
      openAiCodexAccess,
      accountId,
      activeModel ? { model: activeModel } : undefined,
    );
  };

  // OpenRouter → same Responses API format, different base URL
  const openRouterSearch = (): WebSearchProvider | undefined => {
    if (provider !== 'openrouter' || !apiKey) return undefined;
    return new ResponsesApiSearchProvider({
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey,
      model: 'openai/gpt-4o-mini',
    });
  };

  // Google → Gemini API with native Google Search grounding
  const googleSearch = (): WebSearchProvider | undefined => {
    if (provider !== 'google' || !apiKey) return undefined;
    return new GoogleSearchProvider(apiKey);
  };

  // DeepSeek → its own search tool API (billed per request)
  const deepSeekSearch = (key: string | undefined): WebSearchProvider | undefined =>
    key ? new DeepSeekSearchProvider(key) : undefined;

  if (preferred === 'duckduckgo') {
    return new DDGSearchProvider();
  }

  if (preferred === 'deepseek') {
    // Without a stored key the choice cannot run; stay on the free service.
    return deepSeekSearch(deepSeekSearchKey) ?? new DDGSearchProvider();
  }

  // `auto` — follow the active connection's own search.
  if (provider === 'deepseek' && apiKey) {
    return new DeepSeekSearchProvider(apiKey);
  }

  // Vercel AI Gateway is currently not wired to provider-native search routing.
  // It intentionally falls back to DDG until we add an explicit Responses API mapping.
  //
  // No connection-native search → universal fallback, no API key required
  return openAiSearch() ?? chatGptSearch() ?? openRouterSearch() ?? googleSearch() ?? new DDGSearchProvider();
}
