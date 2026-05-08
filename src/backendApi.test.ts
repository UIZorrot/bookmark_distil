import { describe, expect, it, vi } from 'vitest';

import {
  callHostedChatCompletion,
  createBillingPortalSession,
  createCheckoutSession,
  downloadSyncState,
  getMemberProfile,
  redeemInviteCode,
  requestEmailVerificationCode,
  uploadSyncState,
  verifyEmailVerificationCode,
} from './backendApi';

describe('backend API client', () => {
  it('calls hosted member AI with Bearer auth and OpenAI-compatible payload', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hosted answer' } }],
      }),
    });

    const res = await callHostedChatCompletion(
      {
        apiBase: 'https://tool.bookmark.txzy.net/api/v1',
        token: 'member-token',
      },
      {
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.2,
      },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith('https://tool.bookmark.txzy.net/api/v1/member/ai/chat/completions', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer member-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.2,
      }),
    });
    expect(res).toEqual({ status: 'ok', answer: 'hosted answer' });
  });

  it('normalizes API base for auth and billing endpoints', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ detail: 'email_code_sent', auth_mode: 'email_code' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 't', email: 'u@example.com', user_id: 'u1' }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://checkout.stripe.test' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          detail: 'invite_code_redeemed',
          subscription_status: 'active',
          subscription_current_period_end: '2027-05-04T00:00:00+00:00',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          email: 'u@example.com',
          pricing_region: 'cn',
          stripe_subscription_status: 'active',
          hosted_ai_enabled: true,
        }),
      });

    await requestEmailVerificationCode('https://tool.bookmark.txzy.net/api/v1/', 'u@example.com', fetcher);
    await verifyEmailVerificationCode('https://tool.bookmark.txzy.net/api/v1/', 'u@example.com', '123456', fetcher);
    await createCheckoutSession({ apiBase: 'https://tool.bookmark.txzy.net/api/v1/', token: 'member-token' }, fetcher);
    await redeemInviteCode({ apiBase: 'https://tool.bookmark.txzy.net/api/v1/', token: 'member-token' }, 'BD-INVITE-1234', fetcher);
    await getMemberProfile({ apiBase: 'https://tool.bookmark.txzy.net/api/v1/', token: 'member-token' }, fetcher);

    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      'https://tool.bookmark.txzy.net/api/v1/auth/email/send',
      'https://tool.bookmark.txzy.net/api/v1/auth/email/verify',
      'https://tool.bookmark.txzy.net/api/v1/billing/checkout/session',
      'https://tool.bookmark.txzy.net/api/v1/member/invites/redeem',
      'https://tool.bookmark.txzy.net/api/v1/member/me',
    ]);
    expect(JSON.parse(fetcher.mock.calls[1][1].body as string)).toEqual({ email: 'u@example.com', code: '123456' });
    expect(fetcher.mock.calls[2][1].body).toBeUndefined();
    expect(JSON.parse(fetcher.mock.calls[3][1].body as string)).toEqual({ code: 'BD-INVITE-1234' });
  });

  it('creates a billing portal session with Bearer auth', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://billing.stripe.test/portal' }),
    });

    const res = await createBillingPortalSession(
      { apiBase: 'https://tool.bookmark.txzy.net/api/v1/', token: 'member-token' },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith('https://tool.bookmark.txzy.net/api/v1/billing/portal/session', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer member-token',
        'Content-Type': 'application/json',
      },
    });
    expect(res).toEqual({ status: 'ok', url: 'https://billing.stripe.test/portal' });
  });

  it('returns an error when verification email cannot be sent', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const res = await requestEmailVerificationCode('http://127.0.0.1:8789/api/v1', 'u@example.com', fetcher);

    expect(res).toEqual({
      status: 'error',
      message: 'Network request failed. Check whether the local backend is running and reachable.',
    });
  });

  it('uploads and downloads sync state with Bearer auth', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ revision: 2 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          revision: 2,
          payload: { collections: {}, readHistory: ['a'], trashIndex: {} },
        }),
      });

    const upload = await uploadSyncState(
      { apiBase: 'http://127.0.0.1:8789/api/v1/', token: 'member-token' },
      { collections: {}, readHistory: ['a'], trashIndex: {} },
      fetcher,
    );
    const download = await downloadSyncState(
      { apiBase: 'http://127.0.0.1:8789/api/v1/', token: 'member-token' },
      fetcher,
    );

    expect(upload).toEqual({ status: 'ok', revision: 2 });
    expect(download).toEqual({
      status: 'ok',
      revision: 2,
      payload: { collections: {}, readHistory: ['a'], trashIndex: {} },
    });
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      'http://127.0.0.1:8789/api/v1/sync/state',
      'http://127.0.0.1:8789/api/v1/sync/state',
    ]);
  });
});
