import { describe, expect, it } from 'vitest';

import { buildLlmHeaders, normalizeLlmEndpoint } from './llmRequest';

describe('llm request helpers', () => {
  it('normalizes openrouter api base to chat completions endpoint', () => {
    expect(normalizeLlmEndpoint('https://openrouter.ai/api/v1')).toEqual({
      url: 'https://openrouter.ai/api/v1/chat/completions',
    });
  });

  it('does not attach openrouter attribution headers for byok requests', () => {
    expect(buildLlmHeaders('https://openrouter.ai/api/v1/chat/completions', 'sk-or-test')).toEqual({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer sk-or-test',
    });
  });
});
