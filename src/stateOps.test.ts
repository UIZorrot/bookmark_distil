import { describe, expect, it } from 'vitest';

import { moveItemToTrashState, restoreTrashItemState } from './stateOps';

describe('trash state operations', () => {
  it('restores a manually trashed item back into its collection', () => {
    const item = {
      title: 'Saved article',
      url: 'https://example.com/article',
      excerpt: 'A useful article',
      author: 'Author',
      addedAt: 1710000000000,
    };

    const initialCollections = {
      collection_1: {
        id: 'collection_1',
        name: 'Read later',
        items: [item],
        lastUpdated: 1710000000000,
      },
    };

    const moved = moveItemToTrashState(initialCollections, {}, item, 'manual');
    const trashKey = Object.keys(moved.trashIndex)[0];

    expect(moved.collections.collection_1.items).toHaveLength(0);
    expect(moved.trashIndex[trashKey].item?.title).toBe('Saved article');

    const restored = restoreTrashItemState(moved.collections, moved.trashIndex, trashKey);

    expect(restored.trashIndex[trashKey]).toBeUndefined();
    expect(restored.collections.collection_1.items).toHaveLength(1);
    expect(restored.collections.collection_1.items[0].title).toBe('Saved article');
  });
});

