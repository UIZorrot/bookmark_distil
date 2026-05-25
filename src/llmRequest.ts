export function normalizeLlmEndpoint(endpoint?: string) {
  const fallback = 'https://api.openai.com/v1/chat/completions';
  const raw = endpoint?.trim();
  if (!raw) return { url: fallback };

  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, '');

    if (hostname === 'openrouter.ai') {
      if (pathname.startsWith('/docs')) {
        return {
          error: '你填的是 OpenRouter 文档地址，不是接口地址。请使用 `https://openrouter.ai/api/v1` 或 `https://openrouter.ai/api/v1/chat/completions`。',
        };
      }
      if (pathname === '' || pathname === '/' || pathname === '/api' || pathname === '/api/v1') {
        parsed.pathname = '/api/v1/chat/completions';
        parsed.search = '';
        return { url: parsed.toString() };
      }
    }

    if (pathname === '/v1' || pathname === '/api/v1') {
      parsed.pathname = `${pathname}/chat/completions`;
      parsed.search = '';
      return { url: parsed.toString() };
    }

    return { url: parsed.toString() };
  } catch {
    return { error: 'API Endpoint 不是合法 URL。' };
  }
}

export function buildLlmHeaders(_endpoint: string, apiKey: string) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}
