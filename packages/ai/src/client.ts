import { createAnthropic } from '@ai-sdk/anthropic';

/**
 * AI provider configuration for an installation.
 *
 * Two modes are supported:
 * - `direct`: standard Anthropic BYOK. Key is an `sk-ant-...` value used against
 *   api.anthropic.com. This is the default for businesses and self-hosters.
 * - `proxy`: a custom Anthropic-compatible gateway. The key is sent as a Bearer
 *   token against a caller-supplied base URL, with an optional extra header
 *   (name/value) for gateways that require app/tenant identification. Endpoint,
 *   header, and model are all supplied at runtime — nothing gateway-specific is
 *   hardcoded here.
 */
export type AiProvider = 'direct' | 'proxy';

export interface ProviderConfig {
  apiKey: string;
  provider?: AiProvider;
  /** Base URL override — required for `proxy`, ignored for `direct`. */
  baseUrl?: string;
  /** Optional extra header name (e.g. a tenant/app identifier). `proxy` only. */
  headerName?: string;
  /** Value for the optional extra header. `proxy` only. */
  headerValue?: string;
  /** Model id override. Falls back to the direct-mode default when omitted. */
  model?: string;
}

// Direct-mode default model (latest Anthropic Sonnet). Proxy mode has no default
// model — the gateway's model id must be supplied at runtime via config.
export const DEFAULT_MODEL_DIRECT = 'claude-sonnet-5';

/** Kept for backward compatibility — direct-mode default model. */
export const CLAUDE_MODEL = DEFAULT_MODEL_DIRECT;

export interface ResolvedProvider {
  /** Anthropic provider instance to pass a model id into. */
  anthropic: ReturnType<typeof createAnthropic>;
  /** Model id to use for this installation. */
  model: string;
}

export function createAnthropicForInstallation(
  config: ProviderConfig | string
): ResolvedProvider {
  // Backward-compatible: a bare string is treated as a direct-mode key.
  const cfg: ProviderConfig =
    typeof config === 'string' ? { apiKey: config, provider: 'direct' } : config;

  const provider = cfg.provider ?? 'direct';

  if (provider === 'proxy') {
    if (!cfg.baseUrl) {
      throw new Error('proxy provider requires baseUrl');
    }
    if (!cfg.model) {
      throw new Error('proxy provider requires model');
    }
    const anthropic = createAnthropic({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(cfg.headerName && cfg.headerValue
          ? { [cfg.headerName]: cfg.headerValue }
          : {}),
      },
    });
    return { anthropic, model: cfg.model };
  }

  // direct mode
  const anthropic = createAnthropic({ apiKey: cfg.apiKey });
  return { anthropic, model: cfg.model ?? DEFAULT_MODEL_DIRECT };
}
