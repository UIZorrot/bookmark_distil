import { describe, expect, it } from 'vitest';

import {
  clearStoredTrashState,
  deleteAllLowQualityState,
  moveItemToTrashState,
  restoreTrashItemState,
} from './stateOps';

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

  it('clears only stored trash records and keeps low-quality items in collections', () => {
    const lowValueItem = {
      title: 'Thin post',
      url: 'https://example.com/low',
      excerpt: 'Short',
      author: 'Author',
      addedAt: 1710000000000,
      qualityTier: 'low' as const,
    };
    const keptItem = {
      title: 'Manual trash item source',
      url: 'https://example.com/keep',
      excerpt: 'Useful',
      author: 'Author',
      addedAt: 1710000001000,
    };

    const cleared = clearStoredTrashState(
      {
        collection_1: {
          id: 'collection_1',
          name: 'Read later',
          items: [lowValueItem, keptItem],
          lastUpdated: 1710000002000,
        },
      },
      {
        'https://example.com/trashed': {
          key: 'https://example.com/trashed',
          title: 'Stored trash',
          url: 'https://example.com/trashed',
          removedAt: 1710000003000,
          reason: 'manual',
        },
      }
    );

    expect(cleared.trashIndex).toEqual({});
    expect(cleared.collections.collection_1.items).toHaveLength(2);
    expect(cleared.collections.collection_1.items[0].url).toBe('https://example.com/low');
  });

  it('deletes all low-quality items permanently and keeps stored trash records intact', () => {
    const lowValueItem = {
      title: 'Thin post',
      url: 'https://example.com/low',
      excerpt: 'Short',
      author: 'Author',
      addedAt: 1710000000000,
      qualityTier: 'low' as const,
    };
    const highValueItem = {
      title: 'Deep article',
      url: 'https://example.com/high',
      excerpt: 'Long',
      author: 'Author',
      addedAt: 1710000001000,
      qualityTier: 'high' as const,
    };

    const deleted = deleteAllLowQualityState(
      {
        collection_1: {
          id: 'collection_1',
          name: 'Read later',
          items: [lowValueItem, highValueItem],
          lastUpdated: 1710000002000,
        },
      },
      {
        'https://example.com/trashed': {
          key: 'https://example.com/trashed',
          title: 'Stored trash',
          url: 'https://example.com/trashed',
          removedAt: 1710000003000,
          reason: 'manual',
        },
      }
    );

    expect(deleted.collections.collection_1.items).toEqual([highValueItem]);
    expect(deleted.trashIndex['https://example.com/trashed']).toBeDefined();
  });
});
