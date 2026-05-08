export interface TrashStateBookmark {
  title: string;
  url: string;
  excerpt: string;
  author: string;
  addedAt: number;
  summary?: string;
  category?: string;
  tags?: string[];
  qualityScore?: number;
  qualityTier?: 'high' | 'medium' | 'low' | 'unclassified';
  recommendationReason?: string;
  analyzed?: boolean;
  manualCategoryLocked?: boolean;
  manualQualityLocked?: boolean;
  containsImage?: boolean;
  containsVideo?: boolean;
}

export interface TrashStateCollection<TItem extends TrashStateBookmark = TrashStateBookmark> {
  id: string;
  name: string;
  items: TItem[];
  lastUpdated: number;
}

export interface TrashStateRecord<TItem extends TrashStateBookmark = TrashStateBookmark> {
  key: string;
  title: string;
  url: string;
  removedAt: number;
  reason: 'low_value' | 'manual' | '404_error';
  collectionId?: string;
  item?: TItem;
}

function normalizeBookmarkUrl(url: string) {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = '';
    parsed.search = '';
    return `${parsed.origin}${parsed.pathname}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function getBookmarkKey(url: string) {
  return normalizeBookmarkUrl(url);
}

export function moveItemToTrashState<TItem extends TrashStateBookmark>(
  collections: Record<string, TrashStateCollection<TItem>>,
  trashIndex: Record<string, TrashStateRecord<TItem>>,
  item: TItem,
  reason: TrashStateRecord['reason'] = 'manual',
) {
  const key = getBookmarkKey(item.url);
  const sourceCollection = Object.values(collections).find((collection) =>
    collection.items.some((entry) => getBookmarkKey(entry.url) === key)
  );

  const nextCollections: Record<string, TrashStateCollection<TItem>> = Object.fromEntries(
    Object.entries(collections).map(([collectionId, collection]) => [
      collectionId,
      {
        ...collection,
        items: collection.items.filter((entry) => getBookmarkKey(entry.url) !== key),
        lastUpdated: Date.now(),
      },
    ])
  );

  const nextTrashIndex: Record<string, TrashStateRecord<TItem>> = {
    ...trashIndex,
    [key]: {
      key,
      title: item.title,
      url: item.url,
      removedAt: Date.now(),
      reason,
      collectionId: sourceCollection?.id,
      item,
    },
  };

  return { collections: nextCollections, trashIndex: nextTrashIndex };
}

export function restoreTrashItemState<TItem extends TrashStateBookmark>(
  collections: Record<string, TrashStateCollection<TItem>>,
  trashIndex: Record<string, TrashStateRecord<TItem>>,
  key: string,
) {
  const record = trashIndex[key];
  if (!record) {
    return { collections, trashIndex };
  }

  const nextTrashIndex = { ...trashIndex };
  delete nextTrashIndex[key];

  const nextCollections: Record<string, TrashStateCollection<TItem>> = { ...collections };
  const collectionId =
    record.collectionId ||
    Object.keys(nextCollections)[0] ||
    `recovered:${key.slice(0, 8)}`;

  const existingCollection = nextCollections[collectionId] || {
    id: collectionId,
    name: collectionId.startsWith('recovered:') ? 'Recovered' : 'Recovered items',
    items: [],
    lastUpdated: Date.now(),
  };

  const restoredItem: TItem = (record.item || {
    title: record.title,
    url: record.url,
    excerpt: '',
    author: 'Unknown',
    addedAt: record.removedAt,
  }) as TItem;

  const filteredItems = existingCollection.items.filter((entry) => getBookmarkKey(entry.url) !== key);
  nextCollections[collectionId] = {
    ...existingCollection,
    items: [...filteredItems, restoredItem],
    lastUpdated: Date.now(),
  };

  return { collections: nextCollections, trashIndex: nextTrashIndex };
}
