import { describe, expect, it } from 'vitest';

import { createAppNotification } from './notification';

describe('createAppNotification', () => {
  it('trims message content and preserves kind', () => {
    const notice = createAppNotification('error', '  failed to connect  ');

    expect(notice.kind).toBe('error');
    expect(notice.message).toBe('failed to connect');
  });

  it('creates distinct ids for successive notifications', () => {
    const first = createAppNotification('info', 'a');
    const second = createAppNotification('info', 'b');

    expect(second.id).toBeGreaterThan(first.id);
  });
});
