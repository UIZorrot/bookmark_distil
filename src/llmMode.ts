export type LlmMode = 'byok' | 'hosted';

export function resolveLlmModeView(input: {
  memberActive: boolean;
  currentMode?: LlmMode;
}) {
  const normalizedMode: LlmMode = input.currentMode === 'hosted' ? 'hosted' : 'byok';
  const hostedAvailable = input.memberActive;
  const effectiveMode: LlmMode = hostedAvailable ? normalizedMode : 'byok';
  return {
    effectiveMode,
    hostedAvailable,
    upgradeHint: !hostedAvailable,
  };
}
