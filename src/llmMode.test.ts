import { describe, expect, it } from 'vitest';
import { resolveLlmModeView, type LlmMode } from './llmMode';

describe('resolveLlmModeView', () => {
  it('keeps hosted mode when membership is active', () => {
    const result = resolveLlmModeView({
      memberActive: true,
      currentMode: 'hosted',
    });
    expect(result.effectiveMode).toBe('hosted');
    expect(result.hostedAvailable).toBe(true);
    expect(result.upgradeHint).toBe(false);
  });

  it('falls back to byok when membership is inactive', () => {
    const result = resolveLlmModeView({
      memberActive: false,
      currentMode: 'hosted',
    });
    expect(result.effectiveMode).toBe('byok');
    expect(result.hostedAvailable).toBe(false);
    expect(result.upgradeHint).toBe(true);
  });

  it('defaults unknown mode to byok', () => {
    const result = resolveLlmModeView({
      memberActive: true,
      currentMode: '' as LlmMode,
    });
    expect(result.effectiveMode).toBe('byok');
  });
});
