export const DEFAULT_MEMBER_API_BASE = import.meta.env.VITE_MEMBER_API_BASE || 'http://127.0.0.1:8789/api/v1';

export type Fetcher = typeof fetch;

export type MemberApiAuth = {
  apiBase?: string;
  token?: string;
};

export type PricingRegion = 'us' | 'cn';

export type TokenOut = {
  access_token: string;
  token_type?: string;
  user_id?: string;
  email: string;
};

export type MemberProfile = {
  email: string;
  pricing_region: PricingRegion;
  stripe_subscription_status: string;
  subscription_current_period_end?: string | null;
  hosted_ai_enabled: boolean;
};

export type SyncPayload = {
  collections: unknown;
  readHistory: unknown;
  trashIndex: unknown;
};

export type ChatRelayPayload = {
  messages: Array<Record<string, unknown>>;
  model?: string;
  temperature?: number;
  max_tokens?: number;
};

export type HostedChatResult =
  | { status: 'ok'; answer: string }
  | { status: 'error'; message: string; statusCode?: number };

export type HostedAiTestResult =
  | { status: 'ok'; provider?: string; model?: string }
  | { status: 'error'; message: string; statusCode?: number };

export function isBadMemberTokenError(result: { status?: string; message?: string; statusCode?: number } | null | undefined) {
  return result?.status === 'error' && result.statusCode === 401 && result.message === 'bad_token';
}

export function normalizeMemberApiBase(apiBase?: string) {
  const raw = apiBase?.trim() || DEFAULT_MEMBER_API_BASE;
  return raw.replace(/\/+$/, '');
}

function endpoint(apiBase: string | undefined, path: string) {
  return `${normalizeMemberApiBase(apiBase)}${path}`;
}

function networkError() {
  return {
    status: 'error' as const,
    message: 'Network request failed. Check whether the local backend is running and reachable.',
  };
}

export function extractTextContent(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() ? value : null;
  }

  if (Array.isArray(value)) {
    const combined = value
      .map((item) => extractTextContent(item))
      .filter((item): item is string => Boolean(item))
      .join('');
    const trimmed = combined.trim();
    return trimmed || null;
  }

  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;

  if (typeof record.text === 'string' && record.text.trim()) {
    return record.text;
  }

  if ('content' in record) {
    return extractTextContent(record.content);
  }

  return null;
}

async function readError(response: Response) {
  try {
    const data = await response.json();
    const detail = (data as { detail?: unknown; error?: { message?: unknown } }).detail;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
    const upstream = (data as { error?: { message?: unknown } }).error?.message;
    if (typeof upstream === 'string' && upstream.trim()) return upstream.trim();
  } catch {
    // Fall through to text.
  }

  try {
    const text = await response.text();
    if (text.trim()) return text.trim().slice(0, 500);
  } catch {
    // ignore
  }

  return `${response.status} ${response.statusText || 'Request failed'}`.trim();
}

export async function requestEmailVerificationCode(apiBase: string | undefined, email: string, fetcher: Fetcher = fetch) {
  let response: Response;
  try {
    response = await fetcher(endpoint(apiBase, '/auth/email/send'), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });
  } catch {
    return networkError();
  }

  if (!response.ok) {
    return { status: 'error' as const, message: await readError(response), statusCode: response.status };
  }

  return { status: 'ok' as const };
}

export async function verifyEmailVerificationCode(apiBase: string | undefined, email: string, code: string, fetcher: Fetcher = fetch) {
  let response: Response;
  try {
    response = await fetcher(endpoint(apiBase, '/auth/email/verify'), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, code }),
    });
  } catch {
    return networkError();
  }

  if (!response.ok) {
    return { status: 'error' as const, message: await readError(response), statusCode: response.status };
  }

  const data = await response.json() as TokenOut;
  if (!data.access_token || !data.email) {
    return { status: 'error' as const, message: 'Login response is missing token or email.' };
  }

  return { status: 'ok' as const, data };
}

export async function createCheckoutSession(auth: MemberApiAuth, fetcher: Fetcher = fetch) {
  const token = auth.token?.trim();
  if (!token) return { status: 'error' as const, message: 'Missing member token.' };

  const response = await fetcher(endpoint(auth.apiBase, '/billing/checkout/session'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    return { status: 'error' as const, message: await readError(response), statusCode: response.status };
  }

  const data = await response.json() as { url?: unknown };
  if (typeof data.url !== 'string' || !data.url.trim()) {
    return { status: 'error' as const, message: 'Checkout response is missing URL.' };
  }

  return { status: 'ok' as const, url: data.url };
}

export async function createBillingPortalSession(auth: MemberApiAuth, fetcher: Fetcher = fetch) {
  const token = auth.token?.trim();
  if (!token) return { status: 'error' as const, message: 'Missing member token.' };

  const response = await fetcher(endpoint(auth.apiBase, '/billing/portal/session'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    return { status: 'error' as const, message: await readError(response), statusCode: response.status };
  }

  const data = await response.json() as { url?: unknown };
  if (typeof data.url !== 'string' || !data.url.trim()) {
    return { status: 'error' as const, message: 'Portal response is missing URL.' };
  }

  return { status: 'ok' as const, url: data.url };
}

export async function redeemInviteCode(auth: MemberApiAuth, code: string, fetcher: Fetcher = fetch) {
  const token = auth.token?.trim();
  if (!token) return { status: 'error' as const, message: 'Missing member token.' };

  let response: Response;
  try {
    response = await fetcher(endpoint(auth.apiBase, '/member/invites/redeem'), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code }),
    });
  } catch {
    return networkError();
  }

  if (!response.ok) {
    return { status: 'error' as const, message: await readError(response), statusCode: response.status };
  }

  const data = await response.json() as { subscription_status?: unknown; subscription_current_period_end?: unknown };
  return {
    status: 'ok' as const,
    subscriptionStatus: typeof data.subscription_status === 'string' ? data.subscription_status : 'active',
    subscriptionCurrentPeriodEnd: typeof data.subscription_current_period_end === 'string' ? data.subscription_current_period_end : null,
  };
}

export async function getMemberProfile(auth: MemberApiAuth, fetcher: Fetcher = fetch) {
  const token = auth.token?.trim();
  if (!token) return { status: 'error' as const, message: 'Missing member token.' };

  const response = await fetcher(endpoint(auth.apiBase, '/member/me'), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    return { status: 'error' as const, message: await readError(response), statusCode: response.status };
  }

  const data = await response.json() as MemberProfile;
  return { status: 'ok' as const, data };
}

export async function callHostedChatCompletion(
  auth: MemberApiAuth,
  payload: ChatRelayPayload,
  fetcher: Fetcher = fetch,
): Promise<HostedChatResult> {
  const token = auth.token?.trim();
  if (!token) return { status: 'error', message: 'Missing member token.' };

  try {
    const response = await fetcher(endpoint(auth.apiBase, '/member/ai/chat/completions'), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { status: 'error', message: await readError(response), statusCode: response.status };
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = extractTextContent(data.choices?.[0]?.message?.content);
    if (content) {
      return { status: 'ok', answer: content };
    }

    return { status: 'error', message: 'Hosted AI returned no answer.' };
  } catch (error) {
    console.error('Hosted AI request failed:', error);
    return { status: 'error', message: 'Hosted AI is unavailable. BYOK and local features still work.' };
  }
}

export async function testHostedAiConnection(
  auth: MemberApiAuth,
  fetcher: Fetcher = fetch,
): Promise<HostedAiTestResult> {
  const token = auth.token?.trim();
  if (!token) return { status: 'error', message: 'Missing member token.' };

  try {
    const response = await fetcher(endpoint(auth.apiBase, '/member/ai/test'), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return { status: 'error', message: await readError(response), statusCode: response.status };
    }

    const data = await response.json() as { ok?: unknown; provider?: unknown; model?: unknown };
    if (data.ok === true) {
      return {
        status: 'ok',
        provider: typeof data.provider === 'string' ? data.provider : undefined,
        model: typeof data.model === 'string' ? data.model : undefined,
      };
    }

    return { status: 'error', message: 'Hosted AI test returned an invalid response.' };
  } catch (error) {
    console.error('Hosted AI test request failed:', error);
    return { status: 'error', message: 'Hosted AI is unavailable. BYOK and local features still work.' };
  }
}

export async function uploadSyncState(auth: MemberApiAuth, payload: SyncPayload, fetcher: Fetcher = fetch) {
  const token = auth.token?.trim();
  if (!token) return { status: 'error' as const, message: 'Missing member token.' };

  const response = await fetcher(endpoint(auth.apiBase, '/sync/state'), {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ payload }),
  });

  if (!response.ok) {
    return { status: 'error' as const, message: await readError(response), statusCode: response.status };
  }

  const data = await response.json() as { revision?: unknown };
  return { status: 'ok' as const, revision: typeof data.revision === 'number' ? data.revision : 0 };
}

export async function downloadSyncState(auth: MemberApiAuth, fetcher: Fetcher = fetch) {
  const token = auth.token?.trim();
  if (!token) return { status: 'error' as const, message: 'Missing member token.' };

  const response = await fetcher(endpoint(auth.apiBase, '/sync/state'), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    return { status: 'error' as const, message: await readError(response), statusCode: response.status };
  }

  const data = await response.json() as { revision?: unknown; payload?: unknown };
  return {
    status: 'ok' as const,
    revision: typeof data.revision === 'number' ? data.revision : 0,
    payload: data.payload as SyncPayload | null,
  };
}
