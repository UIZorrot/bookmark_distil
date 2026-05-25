import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowLeft, ArrowUpRight, ChevronLeft, ChevronRight, Cloud, CreditCard, Eye, Link2, LogOut, MessageSquare, Plus, RefreshCw, Search, Send, Settings, Sparkles, Star, Trash2, UserCircle, X } from 'lucide-react';
import { useEffectEvent } from 'react';
import { resolveLanguage, tr as trRaw, type LanguagePreference } from './i18n';
import {
  DEFAULT_MEMBER_API_BASE,
  createCheckoutSession,
  downloadSyncState,
  getMemberProfile,
  isBadMemberTokenError,
  redeemInviteCode,
  requestEmailVerificationCode,
  uploadSyncState,
  verifyEmailVerificationCode,
  type MemberProfile,
  type SyncPayload,
} from './backendApi';
import { resolveLlmModeView, type LlmMode } from './llmMode';
import { clearStoredTrashState, deleteAllLowQualityState } from './stateOps';

interface BookmarkItem {
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

interface Collection {
  id: string;
  name: string;
  items: BookmarkItem[];
  lastUpdated: number;
}

interface TrashRecord {
  key: string;
  title: string;
  url: string;
  removedAt: number;
  reason: 'low_value' | 'manual' | '404_error';
}

interface TrashItemView extends TrashRecord {
  stored: boolean;
}

interface ItemView extends BookmarkItem {
  key: string;
  sourceCount: number;
  sourceNames: string[];
  isLowValue: boolean;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatThread {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface SyncConflict {
  local: SyncPayload;
  cloud: SyncPayload;
  revision: number;
}


type BgJobStatus =
  | { state: 'idle' }
  | { state: 'running'; phase: 'analysis' | 'revalidate' | 'rescan'; processed: number; total: number; startedAt: number };

function normalizeBgJobStatus(raw: unknown): BgJobStatus {
  if (!raw || typeof raw !== 'object') return { state: 'idle' };
  const o = raw as Record<string, unknown>;
  if (o.state !== 'running') return { state: 'idle' };
  const phase = o.phase === 'analysis' || o.phase === 'revalidate' || o.phase === 'rescan' ? o.phase : 'analysis';
  const processed = typeof o.processed === 'number' ? o.processed : 0;
  const total = typeof o.total === 'number' ? o.total : 0;
  const startedAt = typeof o.startedAt === 'number' ? o.startedAt : Date.now();
  return { state: 'running', phase, processed, total, startedAt };
}

interface ImportTarget {
  platform: 'zhihu' | 'x';
  sourceKey: string;
  normalizedUrl: string;
  labelZh: string;
  labelEn: string;
}

const PAGE_SIZE = 12;
const DEFAULT_CHAT_THREAD_ID = `chat_${Date.now()}`;
const INITIAL_LANG = resolveLanguage('auto');
const SAMPLE_ZHIHU_COLLECTION_URL = 'https://www.zhihu.com/collection/782964767';
const X_BOOKMARKS_URL = 'https://x.com/i/bookmarks';

function bgJobBannerText(bg: BgJobStatus, tr: (zh: string, en: string) => string) {
  if (bg.state !== 'running') return '';
  const pct = bg.total > 0 ? Math.min(100, Math.round((bg.processed / bg.total) * 100)) : 0;
  if (bg.phase === 'revalidate') {
    return tr(`正在校验链接… ${bg.processed} / ${bg.total}（${pct}%）`, `Validating links… ${bg.processed} / ${bg.total} (${pct}%)`);
  }
  if (bg.phase === 'rescan') {
    return tr(`正在重新扫描收藏（LLM）… ${bg.processed} / ${bg.total}（${pct}%）`, `Rescanning bookmarks (LLM)… ${bg.processed} / ${bg.total} (${pct}%)`);
  }
  return tr(`后台分析进行中… ${bg.processed} / ${bg.total}（${pct}%）`, `Background analysis… ${bg.processed} / ${bg.total} (${pct}%)`);
}

function createChatThreadId() {
  return `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function syncFingerprint(payload: SyncPayload) {
  return JSON.stringify(payload);
}

function normalizeCloudSyncPayload(payload: SyncPayload | null | undefined): SyncPayload {
  return {
    collections: payload?.collections && typeof payload.collections === 'object' ? payload.collections : {},
    readHistory: Array.isArray(payload?.readHistory) ? payload.readHistory.filter((v): v is string => typeof v === 'string') : [],
    trashIndex: payload?.trashIndex && typeof payload.trashIndex === 'object' ? payload.trashIndex : {},
  };
}

function asCollectionMap(value: unknown): Record<string, Collection> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, Collection>;
}

function asReadHistoryList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function asTrashIndexMap(value: unknown): Record<string, TrashRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, TrashRecord>;
}


function getQualityTier(score?: number, tier?: 'high' | 'medium' | 'low' | 'unclassified') {
  if (tier) return tier;
  if (typeof score !== 'number') return undefined;
  if (score >= 8) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

function getQualityTierLabel(
  tier: ReturnType<typeof getQualityTier>,
  tr: (zh: string, en: string) => string
) {
  if (tier === 'high') return tr('高质量', 'High quality');
  if (tier === 'medium') return tr('中质量', 'Medium quality');
  if (tier === 'low') return tr('低质量', 'Low quality');
  if (tier === 'unclassified') return tr('未区分', 'Unclassified');
  return tr('未区分', 'Unclassified');
}

function getQualityTierTone(tier: ReturnType<typeof getQualityTier>) {
  if (tier === 'high') return 'bg-emerald-500/10 text-emerald-600';
  if (tier === 'medium') return 'bg-sky-500/10 text-sky-600';
  if (tier === 'low') return 'bg-amber-500/10 text-amber-600';
  return 'bg-zinc-200/70 text-zinc-600';
}

function getFeaturedTitle(title: string) {
  const trimmed = title.trim();
  return trimmed.length > 56 ? `${trimmed.slice(0, 56)}...` : trimmed;
}

function getDefaultAssistantMessage(lang: 'zh-CN' | 'en') {
  return trRaw(lang, '问我你想找什么内容，我会优先从你的收藏夹里找相关条目。', 'Ask what you want to find. I will search your bookmarks first.');
}

function getDefaultChatTitle(index: number, lang: 'zh-CN' | 'en') {
  return trRaw(lang, `对话 ${index}`, `Chat ${index}`);
}

type SearchReason = 'phrase' | 'title' | 'tags' | 'category' | 'summary' | 'excerpt' | 'author' | 'reason' | 'semantic';

interface SearchScore {
  score: number;
  keywordScore: number;
  semanticScore: number;
  reasons: SearchReason[];
}

const SEARCH_ALIAS_GROUPS: Array<{ seeds: string[]; related: string[] }> = [
  { seeds: ['ai', 'llm', 'gpt', 'prompt', 'agent', 'model'], related: ['ai', 'llm', 'gpt', 'prompt', 'agent', 'model'] },
  { seeds: ['search', 'find', 'lookup', 'retrieve', 'retrieval', '检索', '召回'], related: ['search', 'find', 'lookup', 'retrieve', 'retrieval', '检索', '召回'] },
  { seeds: ['summary', 'summarize', 'digest', 'abstract', '摘要', '总结'], related: ['summary', 'summarize', 'digest', 'abstract', '摘要', '总结'] },
  { seeds: ['bookmark', 'bookmarks', 'save', 'saved', 'collection', 'collections', '收藏', '书签', '收藏夹'], related: ['bookmark', 'bookmarks', 'save', 'saved', 'collection', 'collections', '收藏', '书签', '收藏夹'] },
  { seeds: ['tag', 'tags', 'label', 'labels', '标签'], related: ['tag', 'tags', 'label', 'labels', '标签'] },
  { seeds: ['video', 'videos', 'image', 'images', 'visual', '图片', '图像'], related: ['video', 'videos', 'image', 'images', 'visual', '图片', '图像'] },
];

function normalizeSearchText(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^0-9a-z\u4e00-\u9fff]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSearchTokens(value: string) {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  return normalized.split(' ').filter(Boolean);
}

function expandSearchTokens(tokens: string[]) {
  const expanded = new Set(tokens);
  for (const group of SEARCH_ALIAS_GROUPS) {
    if (tokens.some((token) => group.seeds.includes(token))) {
      group.related.forEach((token) => expanded.add(token));
    }
  }
  return Array.from(expanded);
}

function buildSearchGrams(value: string, size = 3) {
  const compact = normalizeSearchText(value).replace(/\s+/g, '');
  if (!compact) return [];
  if (compact.length <= size) return [compact];
  const grams: string[] = [];
  for (let index = 0; index <= compact.length - size; index += 1) {
    grams.push(compact.slice(index, index + size));
  }
  return grams;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function jaccardSimilarity(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of left) {
    if (rightSet.has(token)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function scoreHybridItem(item: ItemView, query: string): SearchScore {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return { score: 0, keywordScore: 0, semanticScore: 0, reasons: [] };
  }

  const queryTokens = splitSearchTokens(normalizedQuery);
  const expandedQueryTokens = expandSearchTokens(queryTokens);
  const normalizedTitle = normalizeSearchText(item.title);
  const normalizedSummary = normalizeSearchText(item.summary || '');
  const normalizedExcerpt = normalizeSearchText(item.excerpt || '');
  const normalizedCategory = normalizeSearchText(item.category || '');
  const normalizedAuthor = normalizeSearchText(item.author || '');
  const normalizedReason = normalizeSearchText(item.recommendationReason || '');
  const normalizedTags = uniqueStrings((item.tags || []).map((tag) => normalizeSearchText(tag)));
  const normalizedCorpus = normalizeSearchText([
    item.title,
    item.summary,
    item.excerpt,
    item.category,
    item.author,
    item.recommendationReason,
    ...(item.tags || []),
  ].join(' '));
  const corpusTokens = expandSearchTokens(splitSearchTokens(normalizedCorpus));
  const corpusTokenSet = new Set(corpusTokens);
  const queryGrams = buildSearchGrams(normalizedQuery);
  const corpusGrams = buildSearchGrams(normalizedCorpus);

  let keywordScore = 0;
  let semanticScore = 0;
  const reasons = new Set<SearchReason>();
  const matchedFields = new Set<SearchReason>();

  if (normalizedTitle.includes(normalizedQuery)) {
    keywordScore += 28;
    reasons.add('phrase');
    matchedFields.add('title');
  } else if (queryTokens.some((token) => token && normalizedTitle.includes(token))) {
    keywordScore += 16;
    reasons.add('title');
    matchedFields.add('title');
  }

  if (normalizedTags.some((tag) => queryTokens.some((token) => token && tag.includes(token)))) {
    keywordScore += 14;
    reasons.add('tags');
    matchedFields.add('tags');
  }

  if (normalizedCategory && queryTokens.some((token) => normalizedCategory.includes(token))) {
    keywordScore += 12;
    reasons.add('category');
    matchedFields.add('category');
  }

  if (normalizedSummary && queryTokens.some((token) => normalizedSummary.includes(token))) {
    keywordScore += 8;
    reasons.add('summary');
    matchedFields.add('summary');
  }

  if (normalizedExcerpt && queryTokens.some((token) => normalizedExcerpt.includes(token))) {
    keywordScore += 6;
    reasons.add('excerpt');
    matchedFields.add('excerpt');
  }

  if (normalizedAuthor && queryTokens.some((token) => normalizedAuthor.includes(token))) {
    keywordScore += 5;
    reasons.add('author');
    matchedFields.add('author');
  }

  if (normalizedReason && queryTokens.some((token) => normalizedReason.includes(token))) {
    keywordScore += 6;
    reasons.add('reason');
    matchedFields.add('reason');
  }

  for (const token of queryTokens) {
    if (!token) continue;
    if (normalizedCorpus.includes(token)) {
      keywordScore += token.length >= 5 ? 3 : 2;
    }
  }

  const overlapTokens = expandedQueryTokens.filter((token) => corpusTokenSet.has(token));
  if (overlapTokens.length > 0) {
    semanticScore += Math.min(28, (overlapTokens.length / Math.max(expandedQueryTokens.length, 1)) * 28);
    reasons.add('semantic');
  }

  const gramSimilarity = jaccardSimilarity(queryGrams, corpusGrams);
  if (gramSimilarity > 0) {
    semanticScore += gramSimilarity * 36;
    reasons.add('semantic');
  }

  if (matchedFields.size >= 2) {
    semanticScore += Math.min(12, matchedFields.size * 3);
    reasons.add('semantic');
  }

  if (normalizedQuery.length >= 4 && normalizedCorpus.includes(normalizedQuery)) {
    semanticScore += 10;
    reasons.add('phrase');
  }

  const score = Math.min(100, Math.round(keywordScore * 0.7 + semanticScore * 1.2));
  return {
    score,
    keywordScore: Math.round(keywordScore),
    semanticScore: Math.round(semanticScore),
    reasons: Array.from(reasons),
  };
}

function rankItemsForQuery(items: ItemView[], query: string) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return items.map((item) => ({
      item,
      score: 0,
      keywordScore: 0,
      semanticScore: 0,
      reasons: [] as SearchReason[],
    }));
  }

  return items
    .map((item) => ({ item, ...scoreHybridItem(item, normalizedQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.keywordScore !== left.keywordScore) return right.keywordScore - left.keywordScore;
      return right.item.addedAt - left.item.addedAt;
    });
}

function renderMarkdownInline(text: string) {
  const tokenRegex = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(tokenRegex).filter((part) => part.length > 0);

  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      const content = part.slice(1, -1);
      return (
        <code key={index} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[12px] text-zinc-800">
          {content}
        </code>
      );
    }

    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={index} className="font-semibold text-zinc-900">
          {part.slice(2, -2)}
        </strong>
      );
    }

    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const label = linkMatch[1];
      const href = linkMatch[2];
      return (
        <a key={index} href={href} target="_blank" rel="noreferrer" className="text-emerald-700 underline underline-offset-2 hover:text-emerald-800">
          {label}
        </a>
      );
    }

    return <span key={index}>{part}</span>;
  });
}

function renderMarkdown(content: string) {
  const parts = content.split(/```/);
  const nodes: ReactNode[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isCode = i % 2 === 1;

    if (isCode) {
      const lines = part.replace(/\r/g, '').split('\n');
      const firstLine = lines[0] || '';
      const hasLang = /^[a-zA-Z0-9_-]{1,20}$/.test(firstLine.trim());
      const code = (hasLang ? lines.slice(1).join('\n') : part).trimEnd();
      nodes.push(
        <pre key={`code-${i}`} className="overflow-x-auto rounded-2xl border border-zinc-200 bg-zinc-900 p-4 text-xs text-zinc-100">
          <code className="font-mono leading-6">{code}</code>
        </pre>
      );
      continue;
    }

    const lines = part.replace(/\r/g, '').split('\n');
    let listItems: string[] = [];
    let paragraphLines: string[] = [];

    const flushParagraph = () => {
      if (paragraphLines.length === 0) return;
      const text = paragraphLines.join(' ').trim();
      if (!text) {
        paragraphLines = [];
        return;
      }
      nodes.push(
        <p key={`p-${i}-${nodes.length}`} className="whitespace-pre-wrap text-sm leading-7 text-zinc-800">
          {renderMarkdownInline(text)}
        </p>
      );
      paragraphLines = [];
    };

    const flushList = () => {
      if (listItems.length === 0) return;
      nodes.push(
        <ul key={`ul-${i}-${nodes.length}`} className="list-disc space-y-2 pl-5 text-sm leading-7 text-zinc-800">
          {listItems.map((item, idx) => (
            <li key={idx}>{renderMarkdownInline(item)}</li>
          ))}
        </ul>
      );
      listItems = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      const trimmed = line.trim();

      if (!trimmed) {
        flushList();
        flushParagraph();
        continue;
      }

      const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)$/);
      if (headingMatch) {
        flushList();
        flushParagraph();
        const level = headingMatch[1].length;
        const text = headingMatch[2].trim();
        nodes.push(
          level === 1 ? (
            <h3 key={`h-${i}-${nodes.length}`} className="text-lg font-semibold text-zinc-900">
              {renderMarkdownInline(text)}
            </h3>
          ) : level === 2 ? (
            <h4 key={`h-${i}-${nodes.length}`} className="text-base font-semibold text-zinc-900">
              {renderMarkdownInline(text)}
            </h4>
          ) : (
            <h5 key={`h-${i}-${nodes.length}`} className="text-sm font-semibold text-zinc-900">
              {renderMarkdownInline(text)}
            </h5>
          )
        );
        continue;
      }

      const listMatch = trimmed.match(/^[-*]\s+(.*)$/);
      if (listMatch) {
        flushParagraph();
        listItems.push(listMatch[1]);
        continue;
      }

      paragraphLines.push(trimmed);
    }

    flushList();
    flushParagraph();
  }

  return <div className="space-y-3">{nodes}</div>;
}

function parseImportTarget(input: string): ImportTarget | null {
  try {
    const url = new URL(input.trim());
    const hostname = url.hostname.toLowerCase();

    if (hostname.includes('zhihu.com')) {
      const match = url.pathname.match(/^\/collection\/(\d+)/);
      if (!match) return null;
      return {
        platform: 'zhihu',
        sourceKey: `zhihu:collection:${match[1]}`,
        normalizedUrl: `${url.origin}/collection/${match[1]}`,
        labelZh: '知乎收藏夹',
        labelEn: 'Zhihu collection',
      };
    }

    if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname.endsWith('.x.com') || hostname.endsWith('.twitter.com')) && url.pathname.startsWith('/i/bookmarks')) {
      return {
        platform: 'x',
        sourceKey: 'x:bookmarks',
        normalizedUrl: `${url.origin}/i/bookmarks`,
        labelZh: 'X 书签',
        labelEn: 'X bookmarks',
      };
    }

    return null;
  } catch {
    return null;
  }
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

function getBookmarkKey(url: string) {
  return normalizeBookmarkUrl(url);
}

function mergeUniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildItemViews(collections: Record<string, Collection>, trashIndex: Record<string, TrashRecord>) {
  const itemMap = new Map<string, ItemView>();
  let duplicateCount = 0;

  for (const collection of Object.values(collections)) {
    for (const item of collection.items) {
      const key = getBookmarkKey(item.url);
      const existing = itemMap.get(key);

      if (existing) {
        duplicateCount += 1;
        itemMap.set(key, {
          ...existing,
          ...item,
          key,
          excerpt: item.excerpt || existing.excerpt,
          summary: item.summary || existing.summary,
          author: item.author !== 'Unknown' ? item.author : existing.author,
          category: item.category || existing.category,
          recommendationReason: item.recommendationReason || existing.recommendationReason,
          qualityScore: Math.max(item.qualityScore || 0, existing.qualityScore || 0) || undefined,
          analyzed: item.analyzed || existing.analyzed,
          manualCategoryLocked: item.manualCategoryLocked || existing.manualCategoryLocked,
          addedAt: Math.min(existing.addedAt, item.addedAt),
          sourceCount: existing.sourceCount + 1,
          sourceNames: mergeUniqueStrings([...existing.sourceNames, collection.name]),
          tags: mergeUniqueStrings([...(existing.tags || []), ...(item.tags || [])]),
          isLowValue: Math.min(item.qualityScore ?? 10, existing.qualityScore ?? 10) <= 3,
        });
        continue;
      }

      itemMap.set(key, {
        ...item,
        key,
        sourceCount: 1,
        sourceNames: [collection.name],
        isLowValue: (item.qualityScore ?? 10) <= 3,
      });
    }
  }

  const allItems = Array.from(itemMap.values()).sort((a, b) => b.addedAt - a.addedAt);
  const activeItems = allItems.filter(
    (item) => !trashIndex[item.key] && getQualityTier(item.qualityScore, item.qualityTier) !== 'low'
  );

  const derivedLowQualityItems: TrashItemView[] = allItems
    .filter((item) => getQualityTier(item.qualityScore, item.qualityTier) === 'low' && !trashIndex[item.key])
    .map((item) => ({
      key: item.key,
      title: item.title,
      url: item.url,
      removedAt: item.addedAt,
      reason: 'low_value',
      stored: false,
    }));

  const storedTrashItems: TrashItemView[] = Object.values(trashIndex).map((item) => ({
    ...item,
    stored: true,
  }));

  const trashItems = [...storedTrashItems, ...derivedLowQualityItems].sort((a, b) => b.removedAt - a.removedAt);

  return { allItems, activeItems, trashItems, duplicateCount };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'collections' | 'chat' | 'trash' | 'account' | 'settings'>('collections');
  const [collections, setCollections] = useState<Record<string, Collection>>({});
  const [settings, setSettings] = useState<{
    apiKey: string;
    endpoint: string;
    model: string;
    aiMode: LlmMode;
    accessPassword: string;
    language: LanguagePreference;
    memberToken: string;
    memberEmail: string;
  }>({ apiKey: '', endpoint: '', model: '', aiMode: 'byok', accessPassword: '', language: 'auto', memberToken: '', memberEmail: '' });
  const [isTestingLlm, setIsTestingLlm] = useState(false);
  const [readHistory, setReadHistory] = useState<string[]>([]);
  const [trashIndex, setTrashIndex] = useState<Record<string, TrashRecord>>({});
  const [importUrl, setImportUrl] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const [browseQuery, setBrowseQuery] = useState('');
  const [bgJob, setBgJob] = useState<BgJobStatus>({ state: 'idle' });
  const [isImporting, setIsImporting] = useState(false);
  const [itemFilter, setItemFilter] = useState<'all' | 'high' | 'medium' | 'low'>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);
  const [draftSummary, setDraftSummary] = useState('');
  const [draftCategory, setDraftCategory] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [draftQualityScore, setDraftQualityScore] = useState('');
  const [draftQualityTier, setDraftQualityTier] = useState<'high' | 'medium' | 'low' | 'unclassified'>('medium');
  const [unlockInput, setUnlockInput] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [isUnlocked, setIsUnlocked] = useState(true);
  const [readingItemKey, setReadingItemKey] = useState<string | null>(null);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>(() => {
    return [
      {
        id: DEFAULT_CHAT_THREAD_ID,
        title: getDefaultChatTitle(1, INITIAL_LANG),
        messages: [{ role: 'assistant', content: getDefaultAssistantMessage(INITIAL_LANG) }],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
  });
  const [activeChatId, setActiveChatId] = useState<string>(() => DEFAULT_CHAT_THREAD_ID);
  const [chatInput, setChatInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [memberEmailInput, setMemberEmailInput] = useState('');
  const [emailVerificationCodeInput, setEmailVerificationCodeInput] = useState('');
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [memberProfile, setMemberProfile] = useState<MemberProfile | null>(null);
  const [memberMessage, setMemberMessage] = useState('');
  const [isMemberBusy, setIsMemberBusy] = useState(false);
  const [syncConflict, setSyncConflict] = useState<SyncConflict | null>(null);
  const [showSyncConflictActions, setShowSyncConflictActions] = useState(false);
  const chatThreadsLoadedRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const syncInitializedRef = useRef(false);
  const lastSyncedSnapshotRef = useRef('');
  const applyingCloudSyncRef = useRef(false);
  const activeChat = useMemo(() => chatThreads.find((thread) => thread.id === activeChatId) || chatThreads[0], [chatThreads, activeChatId]);
  const activeMessages = activeChat?.messages || [];
  const lang = resolveLanguage(settings.language);
  const bgBusy = bgJob.state === 'running';
  const MEMBER_API_BASE = DEFAULT_MEMBER_API_BASE;
  const tr = useMemo(() => {
    return (zh: string, en: string) => trRaw(lang, zh, en);
  }, [lang]);
  const memberProSubscriptionActive = useMemo(() => {
    const s = memberProfile?.stripe_subscription_status?.trim().toLowerCase() || '';
    return s === 'active' || s === 'trialing';
  }, [memberProfile]);
  const llmModeView = useMemo(
    () =>
      resolveLlmModeView({
        memberActive: memberProSubscriptionActive,
        currentMode: settings.aiMode,
      }),
    [memberProSubscriptionActive, settings.aiMode],
  );
  const currentSyncPayload = useMemo(
    () => ({ collections, readHistory, trashIndex } as SyncPayload),
    [collections, readHistory, trashIndex],
  );
  const currentSyncFingerprint = useMemo(() => syncFingerprint(currentSyncPayload), [currentSyncPayload]);
  const cloudSyncEnabled = Boolean(memberProfile?.hosted_ai_enabled);
  const handleMemberAuthFailure = useEffectEvent(async (result: { status?: string; message?: string; statusCode?: number }) => {
    if (!isBadMemberTokenError(result)) return false;
    await logoutMember(tr('登录状态已失效，请重新登录。', 'Your session expired. Please sign in again.'));
    return true;
  });

  const getSearchReasonLabel = (reason: SearchReason) => {
    if (reason === 'phrase') return tr('精确短语', 'Exact phrase');
    if (reason === 'title') return tr('标题', 'Title');
    if (reason === 'tags') return tr('标签', 'Tags');
    if (reason === 'category') return tr('分类', 'Category');
    if (reason === 'summary') return tr('摘要', 'Summary');
    if (reason === 'excerpt') return tr('摘录', 'Excerpt');
    if (reason === 'author') return tr('作者', 'Author');
    if (reason === 'reason') return tr('推荐理由', 'Recommendation');
    return tr('语义相近', 'Semantic match');
  };

  useEffect(() => {
    chrome.storage.local.get(
      ['collections', 'settings', 'readHistory', 'lastImportUrl', 'trashIndex', 'chatHistory', 'chatThreads', 'activeChatId', 'bgJobStatus'],
      (data) => {
      if (data.collections) setCollections(data.collections as Record<string, Collection>);
      if (data.settings) {
        const loadedSettings = data.settings as {
          apiKey?: string;
          endpoint?: string;
          model?: string;
          aiMode?: LlmMode;
          accessPassword?: string;
          language?: LanguagePreference;
          memberToken?: string;
          memberEmail?: string;
        };
        const loadedLanguage =
          loadedSettings.language === 'zh-CN' || loadedSettings.language === 'en' || loadedSettings.language === 'auto' ? loadedSettings.language : 'auto';
        setSettings({
          apiKey: loadedSettings.apiKey || '',
          endpoint: loadedSettings.endpoint || '',
          model: loadedSettings.model || '',
          aiMode: loadedSettings.aiMode === 'hosted' ? 'hosted' : 'byok',
          accessPassword: loadedSettings.accessPassword || '',
          language: loadedLanguage,
          memberToken: loadedSettings.memberToken || '',
          memberEmail: loadedSettings.memberEmail || '',
        });
        setMemberEmailInput(loadedSettings.memberEmail || '');
        setIsUnlocked(!loadedSettings.accessPassword);
      }
      if (data.readHistory) setReadHistory(data.readHistory as string[]);
      if (data.lastImportUrl) setImportUrl(data.lastImportUrl as string);
      if (data.bgJobStatus !== undefined) setBgJob(normalizeBgJobStatus(data.bgJobStatus));
      if (data.trashIndex) setTrashIndex(data.trashIndex as Record<string, TrashRecord>);
      if (Array.isArray(data.chatThreads) && data.chatThreads.length > 0) {
        const threads = data.chatThreads as ChatThread[];
        setChatThreads(threads);
        const savedActive = typeof data.activeChatId === 'string' ? data.activeChatId : '';
        setActiveChatId(savedActive && threads.some((t) => t.id === savedActive) ? savedActive : threads[0].id);
      } else if (Array.isArray(data.chatHistory)) {
        const now = Date.now();
        const migrated: ChatThread = {
          id: `chat_${now}`,
          title: getDefaultChatTitle(1, INITIAL_LANG),
          messages: data.chatHistory as ChatMessage[],
          createdAt: now,
          updatedAt: now,
        };
        setChatThreads([migrated]);
        setActiveChatId(migrated.id);
      }
      chatThreadsLoadedRef.current = true;
    });

    const listener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes.collections) setCollections((changes.collections.newValue as Record<string, Collection>) || {});
      if (changes.readHistory) setReadHistory((changes.readHistory.newValue as string[]) || []);
      if (changes.trashIndex) setTrashIndex((changes.trashIndex.newValue as Record<string, TrashRecord>) || {});
      if (changes.bgJobStatus) {
        setBgJob(normalizeBgJobStatus(changes.bgJobStatus.newValue));
      }
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, []);


  useEffect(() => {
    if (!chatThreadsLoadedRef.current) return;
    const trimmedThreads = chatThreads.map((thread) => ({
      ...thread,
      messages: thread.messages.slice(-200),
    }));
    chrome.storage.local.set({ chatThreads: trimmedThreads, activeChatId: activeChatId || trimmedThreads[0]?.id });
  }, [chatThreads, activeChatId]);

  useEffect(() => {
    if (activeTab !== 'chat') return;
    chatEndRef.current?.scrollIntoView({ block: 'end' });
  }, [activeMessages.length, isChatting, activeTab]);

  useEffect(() => {
    setCurrentPage(1);
  }, [itemFilter, activeTab, browseQuery]);

  useEffect(() => {
    const token = settings.memberToken.trim();
    if (!token) {
      setMemberProfile(null);
      return;
    }
    void (async () => {
      setIsMemberBusy(true);
      const res = await getMemberProfile({ apiBase: MEMBER_API_BASE, token });
      setIsMemberBusy(false);
      if (res.status === 'ok') {
        setMemberProfile(res.data);
        return;
      }
      await handleMemberAuthFailure(res);
    })();
  }, [settings.memberToken, MEMBER_API_BASE]);

  useEffect(() => {
    if (activeTab !== 'account') return;
    const token = settings.memberToken.trim();
    if (!token) return;
    void (async () => {
      setIsMemberBusy(true);
      const res = await getMemberProfile({ apiBase: MEMBER_API_BASE, token });
      setIsMemberBusy(false);
      if (res.status === 'ok') {
        setMemberProfile(res.data);
        return;
      }
      await handleMemberAuthFailure(res);
    })();
  }, [activeTab, settings.memberToken, MEMBER_API_BASE]);

  const handleSaveSettings = () => {
    chrome.storage.local.set({ settings });
    if (!settings.accessPassword) {
      setIsUnlocked(true);
      setUnlockError('');
    }
    alert(tr('设置已保存', 'Settings saved.'));
  };

  const handleTestLlmSettings = () => {
    if (llmModeView.effectiveMode === 'byok' && !settings.apiKey.trim()) {
      alert(tr('请先填写 API Key。', 'Please enter an API Key first.'));
      return;
    }

    setIsTestingLlm(true);

    chrome.runtime.sendMessage(
      {
        type: 'TEST_LLM',
        settings: {
          apiKey: settings.apiKey,
          endpoint: settings.endpoint,
          model: settings.model,
          aiMode: llmModeView.effectiveMode,
          memberToken: settings.memberToken,
        },
      },
      (res) => {
        setIsTestingLlm(false);

        if (chrome.runtime.lastError) {
          alert(tr('测试失败，后台服务暂时不可用。', 'Test failed. Background service is unavailable.'));
          return;
        }

        if (res?.status === 'ok') {
          alert(res.message || tr('LLM 配置测试成功。', 'LLM configuration test succeeded.'));
          return;
        }

        alert(res?.message || tr('LLM 配置测试失败，请检查接口地址、模型名和 API Key。', 'LLM configuration test failed. Check endpoint, model, and API key.'));
      }
    );
  };

  useEffect(() => {
    if (settings.aiMode === llmModeView.effectiveMode) return;
    setSettings((prev) => ({ ...prev, aiMode: llmModeView.effectiveMode }));
  }, [settings.aiMode, llmModeView.effectiveMode]);

  const handleUnlock = () => {
    if (!settings.accessPassword) {
      setIsUnlocked(true);
      return;
    }

    if (unlockInput === settings.accessPassword) {
      setIsUnlocked(true);
      setUnlockError('');
      setUnlockInput('');
      return;
    }

    setUnlockError(tr('密码不正确，请重试。', 'Incorrect password. Please try again.'));
  };

  const refreshMemberProfile = async (token?: string) => {
    const t = (token ?? settings.memberToken).trim();
    if (!t) {
      setMemberProfile(null);
      return;
    }
    setIsMemberBusy(true);
    const res = await getMemberProfile({ apiBase: MEMBER_API_BASE, token: t });
    setIsMemberBusy(false);
    if (res.status === 'ok') {
      setMemberProfile(res.data);
      setMemberMessage('');
      return;
    }
    if (await handleMemberAuthFailure(res)) return;
    setMemberMessage(tr(`无法刷新账号信息：${res.message}`, `Could not refresh account status: ${res.message}`));
  };

  const requestMemberEmailCode = async () => {
    const email = memberEmailInput.trim();
    if (!email) {
      setMemberMessage(tr('请先输入邮箱。', 'Enter your email first.'));
      return;
    }
    setIsMemberBusy(true);
    const res = await requestEmailVerificationCode(MEMBER_API_BASE, email);
    setIsMemberBusy(false);
    if (res.status === 'ok') {
      setMemberMessage(tr('验证码已发送到邮箱，请复制验证码后完成登录。', 'Verification code sent. Paste it below to sign in.'));
      return;
    }
    setMemberMessage(tr(`发送失败：${res.message}`, `Failed to send email: ${res.message}`));
  };

  const verifyMemberEmailCodeLogin = async () => {
    const email = memberEmailInput.trim();
    const code = emailVerificationCodeInput.trim();
    if (!email || !code) {
      setMemberMessage(tr('请先输入邮箱和验证码。', 'Enter both email and verification code.'));
      return;
    }
    setIsMemberBusy(true);
    const res = await verifyEmailVerificationCode(MEMBER_API_BASE, email, code);
    setIsMemberBusy(false);
    if (res.status === 'ok') {
      const next = { ...settings, memberToken: res.data.access_token, memberEmail: res.data.email };
      setSettings(next);
      setMemberEmailInput(res.data.email);
      setEmailVerificationCodeInput('');
      syncInitializedRef.current = false;
      lastSyncedSnapshotRef.current = '';
      setSyncConflict(null);
      setShowSyncConflictActions(false);
      await chrome.storage.local.set({ settings: next });
      await refreshMemberProfile(next.memberToken);
      return;
    }
    setMemberMessage(tr(`登录失败：${res.message}`, `Sign-in failed: ${res.message}`));
  };

  const logoutMember = async (message?: string) => {
    const next = { ...settings, memberToken: '', memberEmail: '' };
    setSettings(next);
    setMemberProfile(null);
    setEmailVerificationCodeInput('');
    syncInitializedRef.current = false;
    lastSyncedSnapshotRef.current = '';
    setSyncConflict(null);
    setShowSyncConflictActions(false);
    await chrome.storage.local.set({ settings: next });
    setMemberMessage(message || tr('已退出登录。', 'Signed out.'));
  };

  const openMemberCheckout = async () => {
    if (!settings.memberToken.trim()) {
      setMemberMessage(tr('请先登录账号。', 'Please sign in first.'));
      return;
    }
    setIsMemberBusy(true);
    const res = await createCheckoutSession({ apiBase: MEMBER_API_BASE, token: settings.memberToken });
    setIsMemberBusy(false);
    if (res.status === 'ok') {
      await chrome.tabs.create({ url: res.url, active: true });
      setMemberMessage(tr('已打开结算页面。支付完成后请刷新订阅状态。', 'Checkout opened. Refresh subscription status after payment.'));
      return;
    }
    if (await handleMemberAuthFailure(res)) return;
    setMemberMessage(tr(`创建支付链接失败：${res.message}`, `Could not create checkout link: ${res.message}`));
  };

  const redeemMemberInviteCode = async () => {
    const code = inviteCodeInput.trim();
    if (!settings.memberToken.trim()) {
      setMemberMessage(tr('请先登录账号。', 'Please sign in first.'));
      return;
    }
    if (!code) {
      setMemberMessage(tr('请输入邀请码。', 'Enter an invite code.'));
      return;
    }
    setIsMemberBusy(true);
    const res = await redeemInviteCode({ apiBase: MEMBER_API_BASE, token: settings.memberToken }, code);
    setIsMemberBusy(false);
    if (res.status === 'ok') {
      setInviteCodeInput('');
      await refreshMemberProfile();
      setMemberMessage(tr('邀请码已兑换，会员状态已更新。', 'Invite code redeemed. Membership status updated.'));
      return;
    }
    if (await handleMemberAuthFailure(res)) return;
    setMemberMessage(tr(`邀请码兑换失败：${res.message}`, `Invite code redemption failed: ${res.message}`));
  };

  useEffect(() => {
    if (!cloudSyncEnabled) {
      syncInitializedRef.current = false;
      lastSyncedSnapshotRef.current = '';
      setSyncConflict(null);
      setShowSyncConflictActions(false);
      return;
    }
    const token = settings.memberToken.trim();
    if (!token) return;
    if (syncInitializedRef.current) return;
    let cancelled = false;
    void (async () => {
      setIsMemberBusy(true);
      const res = await downloadSyncState({ apiBase: MEMBER_API_BASE, token });
      setIsMemberBusy(false);
      if (cancelled) return;
      if (res.status !== 'ok') {
        if (await handleMemberAuthFailure(res)) return;
        setMemberMessage(tr(`云同步初始化失败：${res.message}`, `Cloud sync initialization failed: ${res.message}`));
        return;
      }
      const cloud = normalizeCloudSyncPayload(res.payload);
      const local = normalizeCloudSyncPayload(currentSyncPayload);
      if (res.payload == null) {
        const uploadRes = await uploadSyncState({ apiBase: MEMBER_API_BASE, token }, local);
        if (uploadRes.status === 'ok') {
          syncInitializedRef.current = true;
          lastSyncedSnapshotRef.current = syncFingerprint(local);
          setSyncConflict(null);
          setShowSyncConflictActions(false);
          return;
        }
        if (await handleMemberAuthFailure(uploadRes)) return;
        setMemberMessage(tr(`首次上传云同步失败：${uploadRes.message}`, `Initial cloud upload failed: ${uploadRes.message}`));
        return;
      }
      const cloudFp = syncFingerprint(cloud);
      const localFp = syncFingerprint(local);
      if (cloudFp !== localFp) {
        setSyncConflict({ local, cloud, revision: res.revision || 0 });
        setShowSyncConflictActions(false);
      } else {
        syncInitializedRef.current = true;
        lastSyncedSnapshotRef.current = localFp;
        setSyncConflict(null);
        setShowSyncConflictActions(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cloudSyncEnabled, settings.memberToken, MEMBER_API_BASE, currentSyncPayload, tr]);

  useEffect(() => {
    if (!cloudSyncEnabled) return;
    if (!syncInitializedRef.current) return;
    if (syncConflict) return;
    if (applyingCloudSyncRef.current) return;
    if (currentSyncFingerprint === lastSyncedSnapshotRef.current) return;
    const token = settings.memberToken.trim();
    if (!token) return;
    let cancelled = false;
    void (async () => {
      const res = await uploadSyncState({ apiBase: MEMBER_API_BASE, token }, currentSyncPayload);
      if (cancelled) return;
      if (res.status === 'ok') {
        lastSyncedSnapshotRef.current = currentSyncFingerprint;
        return;
      }
      await handleMemberAuthFailure(res);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    cloudSyncEnabled,
    syncConflict,
    currentSyncPayload,
    currentSyncFingerprint,
    settings.memberToken,
    MEMBER_API_BASE,
  ]);

  const chooseLocalSyncVersion = async () => {
    if (!syncConflict) return;
    const token = settings.memberToken.trim();
    if (!token) return;
    setIsMemberBusy(true);
    const res = await uploadSyncState({ apiBase: MEMBER_API_BASE, token }, syncConflict.local);
    setIsMemberBusy(false);
    if (res.status !== 'ok') {
      if (await handleMemberAuthFailure(res)) return;
      setMemberMessage(tr(`保留本地版本失败：${res.message}`, `Keep local version failed: ${res.message}`));
      return;
    }
    syncInitializedRef.current = true;
    lastSyncedSnapshotRef.current = syncFingerprint(syncConflict.local);
    setSyncConflict(null);
    setShowSyncConflictActions(false);
    setMemberMessage(tr('已保留本地版本并同步到云端。', 'Local version kept and uploaded to cloud.'));
  };

  const chooseCloudSyncVersion = async () => {
    if (!syncConflict) return;
    const cloudCollections = asCollectionMap(syncConflict.cloud.collections);
    const cloudReadHistory = asReadHistoryList(syncConflict.cloud.readHistory);
    const cloudTrashIndex = asTrashIndexMap(syncConflict.cloud.trashIndex);
    applyingCloudSyncRef.current = true;
    setCollections(cloudCollections);
    setReadHistory(cloudReadHistory);
    setTrashIndex(cloudTrashIndex);
    await chrome.storage.local.set({
      collections: cloudCollections,
      readHistory: cloudReadHistory,
      trashIndex: cloudTrashIndex,
    });
    applyingCloudSyncRef.current = false;
    syncInitializedRef.current = true;
    lastSyncedSnapshotRef.current = syncFingerprint(syncConflict.cloud);
    setSyncConflict(null);
    setShowSyncConflictActions(false);
    setMemberMessage(tr('已采用云端版本并覆盖本地数据。', 'Cloud version applied and local data replaced.'));
  };


  const startCrawlFromUrl = async () => {
    const normalized = importUrl.trim();
    const target = parseImportTarget(normalized);

    if (!normalized) {
      setImportMessage(tr('请先输入知乎收藏夹或 X 书签链接。', 'Please enter a Zhihu collection or X bookmarks URL.'));
      return;
    }

    if (!target) {
      setImportMessage(tr(`链接格式不对，请输入知乎收藏夹链接或 ${X_BOOKMARKS_URL} 这样的 X 书签地址。`, `Invalid URL. Enter a Zhihu collection URL or an X bookmarks URL like ${X_BOOKMARKS_URL}.`));
      return;
    }

    setIsImporting(true);
    setImportMessage(tr(`正在打开${target.labelZh}并准备抓取...`, `Opening ${target.labelEn} and preparing to crawl...`));

    try {
      await chrome.storage.local.set({
        lastImportUrl: target.normalizedUrl,
        pendingImport: {
          collectionId: target.sourceKey,
          url: target.normalizedUrl,
          requestedAt: Date.now(),
        },
      });

      await chrome.tabs.create({ url: target.normalizedUrl, active: true });
      setImportMessage(tr('已打开目标页面。保持页面开启，扩展会自动翻页并完成抓取。', 'Target page opened. Keep it open while the extension crawls through the pages.'));
    } catch {
      setImportMessage(tr('打开页面失败，请检查链接或浏览器权限。', 'Failed to open the page. Check the URL or browser permissions.'));
    } finally {
      setIsImporting(false);
    }
  };

  const startAnalysis = () => {
    if (bgBusy) return;
    chrome.runtime.sendMessage({ type: 'START_ANALYSIS' });
  };

  const revalidateAllLinks = () => {
    if (bgBusy) return;
    chrome.runtime.sendMessage({ type: 'REVALIDATE_ALL' });
  };

  const rescanCollections = () => {
    if (bgBusy) return;
    chrome.runtime.sendMessage({ type: 'START_RESCAN' });
  };

  const { allItems: indexedItems, activeItems, trashItems } = useMemo(
    () => buildItemViews(collections, trashIndex),
    [collections, trashIndex]
  );

  const readHistorySet = useMemo(
    () => new Set(readHistory.map((entry) => getBookmarkKey(entry))),
    [readHistory]
  );

  useEffect(() => {
    if (!selectedItemKey) {
      setDraftSummary('');
      setDraftCategory('');
      setDraftTags('');
      setDraftQualityScore('');
      setDraftQualityTier('medium');
      return;
    }

    const selected = indexedItems.find((item) => item.key === selectedItemKey);
    if (!selected) return;
    setDraftSummary(selected.summary || selected.excerpt || '');
    setDraftCategory(selected.category || '');
    setDraftTags((selected.tags || []).join(', '));
    setDraftQualityScore(typeof selected.qualityScore === 'number' ? String(selected.qualityScore) : '');
    setDraftQualityTier(getQualityTier(selected.qualityScore, selected.qualityTier) || 'medium');
  }, [selectedItemKey, indexedItems]);

  const markAsRead = (key: string) => {
    const next = Array.from(new Set([...readHistory.map((entry) => getBookmarkKey(entry)), key]));
    setReadHistory(next);
    chrome.storage.local.set({ readHistory: next });
  };

  const moveItemToTrash = async (item: ItemView, reason: 'manual' | '404_error' = 'manual') => {
    const nextTrashIndex: Record<string, TrashRecord> = {
      ...trashIndex,
      [item.key]: {
        key: item.key,
        title: item.title,
        url: item.url,
        removedAt: Date.now(),
        reason,
      },
    };

    const nextCollections: Record<string, Collection> = Object.fromEntries(
      Object.entries(collections).map(([collectionId, collection]) => [
        collectionId,
        {
          ...collection,
          items: collection.items.filter((entry) => getBookmarkKey(entry.url) !== item.key),
        },
      ])
    );

    setTrashIndex(nextTrashIndex);
    setCollections(nextCollections);
    if (selectedItemKey === item.key) setSelectedItemKey(null);
    await chrome.storage.local.set({ trashIndex: nextTrashIndex, collections: nextCollections });
  };

  const deleteItemPermanently = async (key: string) => {
    const nextCollections: Record<string, Collection> = Object.fromEntries(
      Object.entries(collections).map(([collectionId, collection]) => [
        collectionId,
        {
          ...collection,
          items: collection.items.filter((entry) => getBookmarkKey(entry.url) !== key),
        },
      ])
    );

    const nextTrashIndex = { ...trashIndex };
    delete nextTrashIndex[key];

    setCollections(nextCollections);
    setTrashIndex(nextTrashIndex);
    if (selectedItemKey === key) setSelectedItemKey(null);

    await chrome.storage.local.set({ collections: nextCollections, trashIndex: nextTrashIndex });
  };

  const restoreTrashItem = async (key: string) => {
    if (!trashIndex[key]) return;
    const nextTrashIndex = { ...trashIndex };
    delete nextTrashIndex[key];
    setTrashIndex(nextTrashIndex);
    await chrome.storage.local.set({ trashIndex: nextTrashIndex });
  };

  const clearStoredTrash = async () => {
    if (storedTrashCount === 0) return;
    const nextState = clearStoredTrashState(collections, trashIndex);
    setTrashIndex(nextState.trashIndex);
    if (selectedTrashItem?.stored && selectedTrashItem.reason !== 'low_value') {
      setSelectedItemKey(null);
    }
    await chrome.storage.local.set({ trashIndex: nextState.trashIndex });
  };

  const deleteAllLowQuality = async () => {
    if (lowQualityTrashCount === 0) return;
    const nextState = deleteAllLowQualityState(collections, trashIndex);
    setCollections(nextState.collections);
    if (selectedTrashItem?.reason === 'low_value') {
      setSelectedItemKey(null);
    }
    await chrome.storage.local.set({ collections: nextState.collections });
  };

  const promoteLowQualityItem = async (key: string, targetTier: 'medium' | 'high') => {
    const nextCollections: Record<string, Collection> = Object.fromEntries(
      Object.entries(collections).map(([collectionId, collection]) => [
        collectionId,
        {
          ...collection,
          items: collection.items.map((entry) =>
            getBookmarkKey(entry.url) === key
              ? {
                  ...entry,
                  analyzed: true,
                  qualityTier: targetTier,
                  qualityScore: Math.max(entry.qualityScore || 0, targetTier === 'high' ? 8 : 5),
                }
              : entry
          ),
        },
      ])
    );

    const nextTrashIndex = { ...trashIndex };
    if (nextTrashIndex[key]?.reason === 'low_value') {
      delete nextTrashIndex[key];
    }

    setCollections(nextCollections);
    setTrashIndex(nextTrashIndex);
    if (selectedItemKey === key) setSelectedItemKey(null);
    await chrome.storage.local.set({ collections: nextCollections, trashIndex: nextTrashIndex });
  };

  const saveMetadata = async (key: string) => {
    const normalizedSummary = draftSummary.trim();
    const normalizedCategory = draftCategory.trim();
    const normalizedTags = draftTags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    const parsedQualityScore = Number.parseInt(draftQualityScore.trim(), 10);
    const normalizedQualityScore =
      Number.isFinite(parsedQualityScore) && parsedQualityScore >= 1 && parsedQualityScore <= 10
        ? parsedQualityScore
        : undefined;

    const nextCollections: Record<string, Collection> = Object.fromEntries(
      Object.entries(collections).map(([collectionId, collection]) => [
        collectionId,
        {
          ...collection,
          items: collection.items.map((entry) =>
            getBookmarkKey(entry.url) === key
              ? {
                  ...entry,
                  summary: normalizedSummary || undefined,
                  category: normalizedCategory || undefined,
                  tags: normalizedTags.length ? normalizedTags : undefined,
                  qualityScore: normalizedQualityScore,
                  qualityTier: draftQualityTier,
                  analyzed: true,
                  manualCategoryLocked: true,
                  manualQualityLocked: true,
                }
              : entry
          ),
        },
      ])
    );

    setCollections(nextCollections);
    await chrome.storage.local.set({ collections: nextCollections });
  };

  const createChatThread = () => {
    const now = Date.now();
    const id = createChatThreadId();
    setChatThreads((threads) => {
      const nextIndex = threads.length + 1;
      const thread: ChatThread = {
        id,
        title: getDefaultChatTitle(nextIndex, lang),
        messages: [{ role: 'assistant', content: getDefaultAssistantMessage(lang) }],
        createdAt: now,
        updatedAt: now,
      };
      return [thread, ...threads];
    });
    setActiveChatId(id);
    setChatInput('');
  };

  const deleteChatThread = (threadId: string) => {
    setChatThreads((threads) => {
      const remaining = threads.filter((thread) => thread.id !== threadId);
      if (remaining.length > 0) {
        if (activeChatId === threadId) setActiveChatId(remaining[0].id);
        return remaining;
      }
      const now = Date.now();
      const newThread: ChatThread = {
        id: createChatThreadId(),
        title: getDefaultChatTitle(1, lang),
        messages: [{ role: 'assistant', content: getDefaultAssistantMessage(lang) }],
        createdAt: now,
        updatedAt: now,
      };
      setActiveChatId(newThread.id);
      return [newThread];
    });
  };

  const askBookmarks = () => {
    const question = chatInput.trim();
    if (!question) return;

    const rankedContexts = rankItemsForQuery([...activeItems], question)
      .slice(0, 8)
      .map(({ item, score, keywordScore, semanticScore, reasons }) => ({
        title: item.title,
        url: item.url,
        summary: item.summary,
        excerpt: item.excerpt,
        category: item.category,
        tags: item.tags,
        qualityScore: item.qualityScore,
        qualityTier: getQualityTier(item.qualityScore, item.qualityTier),
        recommendationReason: item.recommendationReason,
        searchScore: score,
        keywordScore,
        semanticScore,
        reasons,
      }));

    const threadId = activeChat?.id || activeChatId;
    setChatThreads((threads) =>
      threads.map((thread) =>
        thread.id === threadId
          ? { ...thread, messages: [...thread.messages, { role: 'user', content: question }], updatedAt: Date.now() }
          : thread
      )
    );
    setChatInput('');
    setIsChatting(true);

    chrome.runtime.sendMessage(
      {
        type: 'ASK_BOOKMARKS',
        question,
        contexts: rankedContexts,
      },
      (res) => {
        setIsChatting(false);

        if (chrome.runtime.lastError) {
          setChatThreads((threads) =>
            threads.map((thread) =>
              thread.id === threadId
                ? {
                    ...thread,
                    messages: [
                      ...thread.messages,
                      {
                        role: 'assistant',
                        content: tr(
                          '对话请求未能送达后台（扩展可能仍在启动），请稍后重试。',
                          'Could not reach the extension background. Please try again in a moment.',
                        ),
                      },
                    ],
                    updatedAt: Date.now(),
                  }
                : thread
            )
          );
          return;
        }

        if (res?.status === 'ok' && res.answer) {
          setChatThreads((threads) =>
            threads.map((thread) =>
              thread.id === threadId
                ? { ...thread, messages: [...thread.messages, { role: 'assistant', content: res.answer }], updatedAt: Date.now() }
                : thread
            )
          );
          return;
        }

        const fallbackErr =
          typeof res?.message === 'string' && res.message.trim()
            ? res.message.trim()
            : tr('暂时无法从你的收藏生成回答（请确认已配置 API Key 且有关联内容）。', 'Could not compose an answer. Check your API key and bookmark context.');

        setChatThreads((threads) =>
          threads.map((thread) =>
            thread.id === threadId
              ? { ...thread, messages: [...thread.messages, { role: 'assistant', content: fallbackErr }], updatedAt: Date.now() }
              : thread
          )
        );
      }
    );
  };

  const browseFilteredItems =
    itemFilter === 'all'
      ? activeItems
      : itemFilter === 'high'
        ? activeItems.filter((item) => getQualityTier(item.qualityScore, item.qualityTier) === 'high')
        : itemFilter === 'medium'
          ? activeItems.filter((item) => getQualityTier(item.qualityScore, item.qualityTier) === 'medium')
          : activeItems.filter((item) => getQualityTier(item.qualityScore, item.qualityTier) === 'low');

  const browseRankedItems = rankItemsForQuery(browseFilteredItems, browseQuery);

  const totalPages = activeTab === 'trash'
    ? Math.max(1, Math.ceil(trashItems.length / PAGE_SIZE))
    : Math.max(1, Math.ceil(browseRankedItems.length / PAGE_SIZE));

  const pagedBrowseItems = browseRankedItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const pagedTrashItems = trashItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const selectedTrashItem = trashItems.find((item) => item.key === selectedItemKey) || null;
  const storedTrashCount = trashItems.filter((item) => item.stored && item.reason !== 'low_value').length;
  const lowQualityTrashCount = trashItems.filter((item) => item.reason === 'low_value').length;
  const readingItem = activeItems.find((item) => item.key === readingItemKey) || null;

  const allItems = indexedItems;
  const unanalyzedCount = allItems.filter((item) => !item.analyzed).length;
  const highQualityCount = allItems.filter((item) => getQualityTier(item.qualityScore, item.qualityTier) === 'high').length;
  const mediumQualityCount = allItems.filter((item) => getQualityTier(item.qualityScore, item.qualityTier) === 'medium').length;
  const lowQualityCount = allItems.filter((item) => getQualityTier(item.qualityScore, item.qualityTier) === 'low').length;
  const topRecommendations = allItems
    .filter((item) => item.analyzed && getQualityTier(item.qualityScore, item.qualityTier) === 'high' && !readHistorySet.has(item.key))
    .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0))
    ;
  const readRecommendations = allItems
    .filter((item) => item.analyzed && getQualityTier(item.qualityScore, item.qualityTier) === 'high' && readHistorySet.has(item.key))
    .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0))
    ;

  if (!isUnlocked) {
    return (
      <div className="min-h-screen bg-transparent text-zinc-900">
        <div className="mx-auto flex min-h-screen w-full max-w-[1600px] items-center justify-center p-10">
          <div className="w-full max-w-md rounded-3xl border border-zinc-200 bg-white p-8 shadow-xl">
            <div className="mb-2 inline-flex rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-600">
              {tr('已锁定', 'Locked Workspace')}
            </div>
            <h1 className="mt-3 text-2xl font-semibold text-zinc-900">{tr('输入访问密码', 'Enter access password')}</h1>
            <p className="mt-2 text-sm text-zinc-400">{tr('这个工作台已开启本地访问密码保护，请输入密码后继续使用。', 'This workspace is protected by a local access password. Enter the password to continue.')}</p>
            <div className="mt-6 space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-zinc-600">{tr('访问密码', 'Password')}</label>
                <input
                  type="password"
                  value={unlockInput}
                  onChange={(e) => setUnlockInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleUnlock();
                  }}
                  className="w-full rounded-xl border border-zinc-200 bg-transparent px-3 py-2 text-zinc-900 outline-none focus:border-emerald-400"
                  placeholder={tr('输入访问密码', 'Enter password')}
                />
                {unlockError && <p className="mt-2 text-sm text-amber-600">{unlockError}</p>}
              </div>
              <button
                onClick={handleUnlock}
                className="w-full rounded-xl bg-white py-2 font-medium text-zinc-900 transition-colors hover:bg-zinc-200"
              >
                {tr('解锁', 'Unlock')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden bg-transparent text-zinc-900">
      <div className="flex h-screen w-full">
        <div className="flex h-screen w-72 flex-col border-r border-zinc-200 bg-white">
          <div className="border-b border-zinc-200 p-6">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-zinc-900">
              <img src="/logo.png" alt="Logo" className="h-6 w-6 rounded" />
              Bookmark Distil
            </h1>
            <p className="mt-2 text-sm text-zinc-400">{tr('把零散收藏夹整理成可阅读、可管理、可推荐的知识库。', 'Turn scattered bookmarks into a readable, manageable, and recommendable knowledge base.')}</p>
          </div>
          <nav className="flex-1 space-y-2 p-4">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors ${activeTab === 'dashboard' ? 'bg-zinc-900 text-white font-medium' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900'}`}
            >
              <Activity className="h-5 w-5" />
              {tr('精选', 'Featured')}
            </button>
            <button
              onClick={() => {
                setActiveTab('collections');
                setItemFilter('all');
              }}
              className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors ${activeTab === 'collections' ? 'bg-zinc-900 text-white font-medium' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900'}`}
            >
              <Star className="h-5 w-5" />
              {tr('浏览', 'Browse')}
            </button>
            <button
              onClick={() => setActiveTab('chat')}
              className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors ${activeTab === 'chat' ? 'bg-zinc-900 text-white font-medium' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900'}`}
            >
              <MessageSquare className="h-5 w-5" />
              {tr('对话', 'Chat')}
            </button>
            <button
              onClick={() => {
                setActiveTab('trash');
                setSelectedItemKey(null);
              }}
              className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors ${activeTab === 'trash' ? 'bg-zinc-900 text-white font-medium' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900'}`}
            >
              <Trash2 className="h-5 w-5" />
              {tr('垃圾箱', 'Trash')}
            </button>
            <button
              onClick={() => setActiveTab('account')}
              className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors ${activeTab === 'account' ? 'bg-zinc-900 text-white font-medium' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900'}`}
            >
              <UserCircle className="h-5 w-5" />
              {tr('账号', 'Account')}
            </button>
            <button
              onClick={() => setActiveTab('settings')}
              className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors ${activeTab === 'settings' ? 'bg-zinc-900 text-white font-medium' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900'}`}
            >
              <Settings className="h-5 w-5" />
              {tr('设置', 'Settings')}
            </button>
          </nav>
        </div>

        <div className="h-screen flex-1 overflow-y-auto bg-transparent">
          {bgBusy && (
            <div className="sticky top-0 z-40 border-b border-amber-200/90 bg-amber-50 px-6 py-2.5 text-sm text-amber-950 backdrop-blur-sm">
              <div className="mx-auto flex max-w-6xl items-center gap-2">
                <RefreshCw className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                <span>{bgJobBannerText(bgJob, tr)}</span>
              </div>
            </div>
          )}
          {readingItem && (
            <div className="fixed inset-0 z-50 overflow-y-auto bg-white">
              <div className="border-b border-zinc-200 bg-white">
                <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
                  <button
                    onClick={() => setReadingItemKey(null)}
                    className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    {tr('返回', 'Back')}
                  </button>
                  <div className="flex items-center gap-2">
                    <a
                      href={readingItem.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                    >
                      <ArrowUpRight className="h-4 w-4" />
                      {tr('打开原文', 'Open original')}
                    </a>
                    <button
                      onClick={() => markAsRead(readingItem.key)}
                      className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                    >
                      {tr('标记已读', 'Mark as read')}
                    </button>
                    <button
                      onClick={() => {
                        void moveItemToTrash(readingItem, 'manual')
                          .then(() => setReadingItemKey(null));
                      }}
                      className="inline-flex items-center gap-2 rounded-xl border border-amber-500/30 px-3 py-2 text-sm text-amber-600 hover:bg-amber-500/10"
                    >
                      <Trash2 className="h-4 w-4" />
                      {tr('删除', 'Delete')}
                    </button>
                    <button
                      onClick={() => {
                        void deleteItemPermanently(readingItem.key).then(() => setReadingItemKey(null));
                      }}
                      className="inline-flex items-center gap-2 rounded-xl border border-red-500/30 px-3 py-2 text-sm text-red-600 hover:bg-red-500/10"
                    >
                      {tr('清除', 'Permanently delete')}
                    </button>
                  </div>
                </div>
              </div>

              <div className="mx-auto max-w-5xl px-6 py-10">
                <div className="mb-6">
                  <h1 className="text-3xl font-semibold text-zinc-900">{readingItem.title}</h1>
                  <p className="mt-2 text-sm text-zinc-400">
                    {tr(`作者 ${readingItem.author} · 来自 ${readingItem.sourceCount} 次导入`, `By ${readingItem.author} · Imported ${readingItem.sourceCount} times`)}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {readingItem.category && <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-600">{readingItem.category}</span>}
                    <span className={`rounded-full px-3 py-1 text-xs ${getQualityTierTone(getQualityTier(readingItem.qualityScore, readingItem.qualityTier))}`}>
                      {getQualityTierLabel(getQualityTier(readingItem.qualityScore, readingItem.qualityTier), tr)}
                      {typeof readingItem.qualityScore === 'number' && getQualityTier(readingItem.qualityScore, readingItem.qualityTier) !== 'unclassified'
                        ? tr(` · 评分 ${readingItem.qualityScore}/10`, ` · Score ${readingItem.qualityScore}/10`)
                        : ''}
                    </span>
                    {(readingItem.containsImage || readingItem.containsVideo) && (
                      <span className="rounded-full bg-violet-500/10 px-3 py-1 text-xs text-violet-600">
                        {readingItem.containsImage && readingItem.containsVideo
                          ? tr('该条目包含视频和图片', 'This item contains video and images')
                          : readingItem.containsVideo
                            ? tr('该条目包含视频', 'This item contains video')
                            : tr('该条目包含图片', 'This item contains images')}
                      </span>
                    )}
                    {(readingItem.tags || []).slice(0, 12).map((tag) => (
                      <span key={tag} className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-600">#{tag}</span>
                    ))}
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                    <h3 className="text-sm font-medium text-zinc-900">{tr('评分与质量', 'Score & quality')}</h3>
                    <p className="mt-2 text-sm text-zinc-400">{tr('你可以手动调整评分和质量等级。', 'You can manually adjust the score and quality tier.')}</p>

                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-sm font-medium text-zinc-600">{tr('评分（1-10）', 'Score (1-10)')}</label>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={draftQualityScore}
                          onChange={(e) => setDraftQualityScore(e.target.value)}
                          className="w-full rounded-xl border border-zinc-200 bg-transparent px-3 py-2 text-zinc-900 outline-none focus:border-emerald-400"
                          placeholder="6"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-zinc-600">{tr('质量等级', 'Quality tier')}</label>
                        <select
                          value={draftQualityTier}
                          onChange={(e) => setDraftQualityTier(e.target.value as 'high' | 'medium' | 'low' | 'unclassified')}
                          className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-zinc-900 outline-none focus:border-emerald-400"
                        >
                          <option value="high">{tr('高质量', 'High quality')}</option>
                          <option value="medium">{tr('中质量', 'Medium quality')}</option>
                          <option value="low">{tr('低质量', 'Low quality')}</option>
                          <option value="unclassified">{tr('未区分', 'Unclassified')}</option>
                        </select>
                      </div>
                    </div>
                    {(readingItem.containsImage || readingItem.containsVideo) && (
                      <div className="mt-4">
                        <span className="rounded-full bg-violet-500/10 px-3 py-1 text-xs text-violet-600">
                          {readingItem.containsImage && readingItem.containsVideo
                            ? tr('该条目包含视频和图片', 'This item contains video and images')
                            : readingItem.containsVideo
                              ? tr('该条目包含视频', 'This item contains video')
                              : tr('该条目包含图片', 'This item contains images')}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                    <h3 className="text-sm font-medium text-zinc-900">{tr('摘要', 'Summary')}</h3>
                    <p className="mt-2 text-sm text-zinc-400">{tr('摘要支持手动编辑和覆写。', 'You can manually edit and override the summary.')}</p>
                    <textarea
                      value={draftSummary}
                      onChange={(e) => setDraftSummary(e.target.value)}
                      className="mt-4 min-h-[180px] w-full rounded-2xl border border-zinc-200 bg-transparent px-4 py-3 text-sm leading-7 text-zinc-900 outline-none focus:border-emerald-400"
                      placeholder={tr('输入或修改摘要', 'Write or edit the summary')}
                    />
                    <div className="mt-4 flex justify-end">
                      <button
                        onClick={() => void saveMetadata(readingItem.key)}
                        className="inline-flex items-center rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100"
                      >
                        {tr('保存修改', 'Save changes')}
                      </button>
                    </div>
                  </div>

                  {readingItem.recommendationReason && (
                    <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                      <h3 className="text-sm font-medium text-zinc-900">{tr('推荐理由', 'Why it is recommended')}</h3>
                      <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-600">{readingItem.recommendationReason}</p>
                    </div>
                  )}

                  <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                    <h3 className="text-sm font-medium text-zinc-900">{tr('元信息', 'Metadata')}</h3>
                    <p className="mt-2 text-sm text-zinc-400">{tr('补充分类与标签，方便后续检索与对话召回。', 'Add category and tags for search and chat retrieval later.')}</p>

                    <div className="mt-4 space-y-4">
                      <div>
                        <label className="mb-1 block text-sm font-medium text-zinc-600">{tr('分类', 'Category')}</label>
                        <input
                          type="text"
                          value={draftCategory}
                          onChange={(e) => setDraftCategory(e.target.value)}
                          className="w-full rounded-xl border border-zinc-200 bg-transparent px-3 py-2 text-zinc-900 outline-none focus:border-emerald-400"
                          placeholder={tr('例如：AI、产品、阅读清单', 'e.g. AI, Product, Reading list')}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-zinc-600">{tr('标签（逗号分隔）', 'Tags (comma separated)')}</label>
                        <input
                          type="text"
                          value={draftTags}
                          onChange={(e) => setDraftTags(e.target.value)}
                          className="w-full rounded-xl border border-zinc-200 bg-transparent px-3 py-2 text-zinc-900 outline-none focus:border-emerald-400"
                          placeholder={tr('例如：RAG, Agent, 向量数据库, Prompt', 'e.g. RAG, Agent, Vector DB, Prompt')}
                        />
                      </div>
                      <button
                        onClick={() => void saveMetadata(readingItem.key)}
                        className="w-full rounded-xl border border-zinc-200 bg-white py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100"
                      >
                        {tr('保存元信息', 'Save metadata')}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'dashboard' && (
            <div className="mx-auto max-w-6xl p-10">
              <div className="mb-6">
                <h2 className="text-2xl font-semibold text-zinc-900">{tr('精选', 'Featured')}</h2>
              </div>

              <div className="space-y-8">
                <div>
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-lg font-semibold text-zinc-900">{tr('未读精选', 'Unread')}</h3>
                    {unanalyzedCount > 0 && (
                      <button
                        onClick={startAnalysis}
                        disabled={bgBusy}
                        title={bgBusy ? tr('请等待当前后台任务结束', 'Wait until the background job finishes') : undefined}
                        className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <RefreshCw className={`h-4 w-4 ${bgBusy ? 'animate-spin' : ''}`} />
                        {tr('分析剩余内容', 'Analyze remaining')}
                      </button>
                    )}
                  </div>

                  <div className="space-y-4">
                    {topRecommendations.length === 0 ? (
                      <div className="rounded-2xl border border-zinc-200/60 bg-white p-6 text-center text-zinc-400">
                        {tr('暂无未读精选。', 'No unread featured items.')}
                      </div>
                    ) : (
                      topRecommendations.map((item) => (
                        <div key={item.key} className="rounded-2xl border border-zinc-200/60 bg-white p-5 transition-colors hover:border-zinc-200">
                          <div className="mb-2 flex items-start justify-between gap-4">
                            <button
                              onClick={() => {
                                setActiveTab('collections');
                                setSelectedItemKey(item.key);
                                setReadingItemKey(item.key);
                              }}
                              className="min-w-0 flex-1 line-clamp-2 break-words pr-2 text-left text-lg font-semibold text-zinc-900 hover:text-emerald-600"
                              title={item.title}
                            >
                              {getFeaturedTitle(item.title)}
                            </button>
                            {typeof item.qualityScore === 'number' && (
                              <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-1 text-xs font-semibold text-emerald-600">
                                {tr(`评分 ${item.qualityScore}/10`, `Score ${item.qualityScore}/10`)}
                              </span>
                            )}
                          </div>
                          <p className="mb-3 line-clamp-2 text-sm text-zinc-400">{item.summary || item.excerpt}</p>
                          {item.recommendationReason && (
                            <div className="mb-3 rounded-xl border border-zinc-200/60 bg-transparent p-3 text-sm text-zinc-600">
                              <span className="font-medium text-zinc-900">{tr('推荐理由：', 'Why: ')}</span>
                              {item.recommendationReason}
                            </div>
                          )}
                          <div className="mt-2 flex items-center justify-between gap-3">
                            <div className="flex flex-wrap gap-2">
                              <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-600">
                                {item.category || tr('未分类', 'Uncategorized')}
                              </span>
                              {(item.tags || []).slice(0, 8).map((tag) => (
                                <span key={tag} className="rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-600">
                                  #{tag}
                                </span>
                              ))}
                            </div>
                            <button
                              onClick={() => markAsRead(item.key)}
                              className="rounded-full bg-white px-3 py-1 text-xs font-medium text-zinc-900 transition-colors hover:bg-zinc-200"
                            >
                              {tr('标记已读', 'Mark as read')}
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div>
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-lg font-semibold text-zinc-900">{tr('已读精选', 'Read')}</h3>
                  </div>

                  <div className="space-y-4">
                    {readRecommendations.length === 0 ? (
                      <div className="rounded-2xl border border-zinc-200/60 bg-white p-6 text-center text-zinc-400">
                        {tr('暂无已读精选。', 'No read featured items.')}
                      </div>
                    ) : (
                      readRecommendations.map((item) => (
                        <div key={item.key} className="rounded-2xl border border-zinc-200/60 bg-white p-5 transition-colors hover:border-zinc-200">
                          <div className="mb-2 flex items-start justify-between gap-4">
                            <button
                              onClick={() => {
                                setActiveTab('collections');
                                setSelectedItemKey(item.key);
                                setReadingItemKey(item.key);
                              }}
                              className="min-w-0 flex-1 line-clamp-2 break-words pr-2 text-left text-lg font-semibold text-zinc-900 hover:text-emerald-600"
                              title={item.title}
                            >
                              {getFeaturedTitle(item.title)}
                            </button>
                            {typeof item.qualityScore === 'number' && (
                              <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-1 text-xs font-semibold text-emerald-600">
                                {tr(`评分 ${item.qualityScore}/10`, `Score ${item.qualityScore}/10`)}
                              </span>
                            )}
                          </div>
                          <p className="mb-3 line-clamp-2 text-sm text-zinc-400">{item.summary || item.excerpt}</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-600">
                              {item.category || tr('未分类', 'Uncategorized')}
                            </span>
                            {(item.tags || []).slice(0, 8).map((tag) => (
                              <span key={tag} className="rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-600">
                                #{tag}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'collections' && (
            <div className="mx-auto max-w-6xl p-10">
              <div className="mb-6">
                <h2 className="text-2xl font-semibold text-zinc-900">{tr('浏览', 'Browse')}</h2>
                <p className="mt-1 text-sm text-zinc-400">{tr('以单条收藏内容作为基本单元管理，收藏夹链接只负责导入，不再作为主视图结构。', 'Manage individual saved items as the main unit. Collection links are used only for import.')}</p>
              </div>

              <div className="mb-6 rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm">
                <div className="mb-4 flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold text-zinc-900">{tr('粘贴链接，一键开始抓取', 'Paste a link to start crawling')}</h3>
                    <p className="mt-1 text-sm text-zinc-400">{tr(`支持知乎收藏夹和 X 书签页，例如 \`${SAMPLE_ZHIHU_COLLECTION_URL}\` 或 \`${X_BOOKMARKS_URL}\`。`, `Supports Zhihu collections and X bookmarks, for example \`${SAMPLE_ZHIHU_COLLECTION_URL}\` or \`${X_BOOKMARKS_URL}\`.`)}</p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="relative flex-1">
                    <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                    <input
                      type="text"
                      value={importUrl}
                      onChange={(e) => setImportUrl(e.target.value)}
                      placeholder={tr('粘贴知乎收藏夹或 X 书签链接', 'Paste a Zhihu collection or X bookmarks URL')}
                      className="w-full rounded-2xl border border-zinc-200 bg-transparent py-3 pl-10 pr-4 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-emerald-400"
                    />
                  </div>
                  <button
                    onClick={startCrawlFromUrl}
                    disabled={isImporting || bgBusy}
                    title={bgBusy ? tr('请等待当前后台任务结束', 'Wait until the background job finishes') : undefined}
                    className="rounded-2xl border border-zinc-200 bg-white px-5 py-3 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
                  >
                    {isImporting ? tr('启动中...', 'Starting...') : tr('开始抓取', 'Start crawling')}
                  </button>
                </div>

                <div className="mt-3 space-y-3">
                  <p className="text-xs text-zinc-400">{importMessage || tr('点击后会自动打开目标页面，并在页面内执行翻页抓取。', 'Click to open the target page and crawl through it automatically.')}</p>
                  <div className="flex flex-wrap gap-3">
                    <button
                      onClick={revalidateAllLinks}
                      disabled={bgBusy}
                      className="inline-flex items-center rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {tr('重新校验所有链接', 'Revalidate all links')}
                    </button>
                    <button
                      onClick={rescanCollections}
                      disabled={bgBusy}
                      className="inline-flex items-center rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {tr('重新扫描收藏', 'Rescan bookmarks')}
                    </button>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-zinc-200/60 bg-transparent p-4 text-sm text-zinc-400">
                  {tr('还没有自己的收藏夹？试试', 'Need a sample collection? Try')}
                  {' '}
                  <a
                    href={SAMPLE_ZHIHU_COLLECTION_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-600 hover:text-emerald-700"
                  >
                    {SAMPLE_ZHIHU_COLLECTION_URL}
                  </a>
                  {' '}
                  {tr('。X 用户也可以直接导入', '. X users can also import')}
                  {' '}
                  <span className="text-zinc-700">{X_BOOKMARKS_URL}</span>
                  {tr('。', '.')}
                </div>
              </div>

              <div className="mb-6 rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden />
                    <input
                      type="text"
                      value={browseQuery}
                      onChange={(e) => setBrowseQuery(e.target.value)}
                      placeholder={tr('搜索标题、摘要、标签、分类或相关语义', 'Search titles, summaries, tags, categories, or related ideas')}
                      className="w-full rounded-2xl border border-zinc-200 bg-transparent py-3 pl-10 pr-4 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-emerald-400"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setBrowseQuery('')}
                    disabled={!browseQuery.trim()}
                    className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {tr('清空搜索', 'Clear search')}
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-500">
                  <span className="rounded-full bg-zinc-100 px-3 py-1">
                    {tr(`${browseRankedItems.length}/${browseFilteredItems.length} 条结果`, `${browseRankedItems.length}/${browseFilteredItems.length} results`)}
                  </span>
                  <span className="rounded-full bg-zinc-100 px-3 py-1">
                    {tr('混合检索：关键词 + 语义', 'Hybrid search: keyword + semantic')}
                  </span>
                  {browseQuery.trim() && (
                    <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-emerald-700">
                      {tr('按相关度排序', 'Ranked by relevance')}
                    </span>
                  )}
                </div>
              </div>

              <div className="mb-6 grid grid-cols-5 gap-3">
                <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-zinc-400">{tr('内容总数', 'Total items')}</div>
                  <div className="mt-2 text-2xl font-semibold text-zinc-900">{activeItems.length}</div>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-zinc-400">{tr('高质量', 'High quality')}</div>
                  <div className="mt-2 text-2xl font-semibold text-emerald-600">{highQualityCount}</div>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-zinc-400">{tr('中质量', 'Medium quality')}</div>
                  <div className="mt-2 text-2xl font-semibold text-sky-600">{mediumQualityCount}</div>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-zinc-400">{tr('低质量', 'Low quality')}</div>
                  <div className="mt-2 text-2xl font-semibold text-amber-600">{lowQualityCount}</div>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-zinc-400">{tr('垃圾箱记录', 'Trash records')}</div>
                  <div className="mt-2 text-2xl font-semibold text-zinc-900">{trashItems.length}</div>
                </div>
              </div>

              <div className="rounded-3xl border border-zinc-200 bg-white shadow-sm">
                <div className="border-b border-zinc-200/60 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold text-zinc-900">{tr('收藏列表', 'Bookmarks')}</h3>
                      <p className="mt-1 text-sm text-zinc-400">{tr('单条内容是基本单元，重复链接自动合并，并按高/中/低质量分层管理。', 'Individual items are the base unit. Duplicate links are merged and grouped by quality.')}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => {
                          setItemFilter('all');
                          setSelectedItemKey(null);
                        }}
                        className={`rounded-full px-3 py-1.5 text-xs transition-colors ${itemFilter === 'all' ? 'bg-white text-zinc-900' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}`}
                      >
                        {tr('全部内容', 'All items')}
                      </button>
                      <button
                        onClick={() => {
                          setItemFilter('high');
                          setSelectedItemKey(null);
                        }}
                        className={`rounded-full px-3 py-1.5 text-xs transition-colors ${itemFilter === 'high' ? 'bg-white text-zinc-900' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}`}
                      >
                        {tr('高质量', 'High quality')}
                      </button>
                      <button
                        onClick={() => {
                          setItemFilter('medium');
                          setSelectedItemKey(null);
                        }}
                        className={`rounded-full px-3 py-1.5 text-xs transition-colors ${itemFilter === 'medium' ? 'bg-white text-zinc-900' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}`}
                      >
                        {tr('中质量', 'Medium quality')}
                      </button>
                      <button
                        onClick={() => {
                          setItemFilter('low');
                          setSelectedItemKey(null);
                        }}
                        className={`rounded-full px-3 py-1.5 text-xs transition-colors ${itemFilter === 'low' ? 'bg-white text-zinc-900' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'}`}
                      >
                        {tr('低质量', 'Low quality')}
                      </button>
                    </div>
                  </div>
                </div>

                {pagedBrowseItems.length === 0 ? (
                  <div className="p-10 text-center text-zinc-400">
                    {browseQuery.trim()
                      ? tr('没有匹配结果。', 'No results match your search.')
                      : itemFilter === 'high'
                        ? tr('当前没有高质量内容。', 'No high-quality items yet.')
                        : itemFilter === 'medium'
                          ? tr('当前没有中质量内容。', 'No medium-quality items yet.')
                          : itemFilter === 'low'
                            ? tr('当前没有低质量内容。', 'No low-quality items yet.')
                            : tr('还没有可展示的收藏内容。', 'No bookmarks to show yet.')}
                  </div>
                ) : (
                  <div className="space-y-3 p-5">
                    {pagedBrowseItems.map(({ item, score, keywordScore, semanticScore, reasons }) => (
                      <div key={item.key} className="rounded-2xl border border-zinc-200/60 bg-white p-4 transition-colors hover:border-zinc-200 hover:bg-zinc-50">
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <button
                                onClick={() => {
                                  setSelectedItemKey(item.key);
                                  setReadingItemKey(item.key);
                                }}
                                className="block min-w-0 flex-1 truncate text-left text-base font-medium text-zinc-900 hover:text-emerald-600"
                              >
                                {item.title}
                              </button>
                              {browseQuery.trim() && (
                                <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-1 text-xs font-semibold text-emerald-700">
                                  {tr(`相关度 ${score}`, `Score ${score}`)}
                                </span>
                              )}
                            </div>
                            <p className="mt-2 line-clamp-2 text-sm text-zinc-400">{item.summary || item.excerpt || tr('暂无摘要', 'No summary yet')}</p>
                            {browseQuery.trim() && (
                              <div className="mt-3 flex flex-wrap gap-2">
                                <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-600">
                                  {tr(`关键词 ${keywordScore}`, `Keyword ${keywordScore}`)}
                                </span>
                                <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-600">
                                  {tr(`语义 ${semanticScore}`, `Semantic ${semanticScore}`)}
                                </span>
                                {reasons.slice(0, 3).map((reason) => (
                                  <span key={reason} className="rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-600">
                                    {getSearchReasonLabel(reason)}
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="mt-3 flex flex-wrap gap-2">
                              <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-600">
                                {item.category || tr('未分类', 'Uncategorized')}
                              </span>
                              <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs text-zinc-600">
                                {tr(`来源 ${item.sourceCount} 次`, `Imported ${item.sourceCount} times`)}
                              </span>
                              <span className={`rounded-full px-2 py-1 text-xs ${getQualityTierTone(getQualityTier(item.qualityScore, item.qualityTier))}`}>
                                {getQualityTierLabel(getQualityTier(item.qualityScore, item.qualityTier), tr)}
                              </span>
                              {(item.containsImage || item.containsVideo) && (
                                <span className="rounded-full bg-violet-500/10 px-2 py-1 text-xs text-violet-600">
                                  {item.containsImage && item.containsVideo ? tr('视频+图片', 'Video + images') : item.containsVideo ? tr('视频', 'Video') : tr('图片', 'Images')}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex shrink-0 gap-2">
                            <button
                              onClick={() => {
                                setSelectedItemKey(item.key);
                                setReadingItemKey(item.key);
                              }}
                              className="rounded-xl border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                            >
                              {tr('详情', 'Details')}
                            </button>
                            <button
                              onClick={() => moveItemToTrash(item, 'manual')}
                              className="rounded-xl border border-amber-500/30 px-3 py-2 text-sm text-amber-600 hover:bg-amber-500/10"
                            >
                              {tr('删除', 'Delete')}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex items-center justify-between border-t border-zinc-200/60 p-4">
                  <p className="text-sm text-zinc-400">
                    {tr(`第 ${currentPage} / ${totalPages} 页`, `Page ${currentPage} / ${totalPages}`)}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                      disabled={currentPage === 1}
                      className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      {tr('上一页', 'Previous')}
                    </button>
                    <button
                      onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                      disabled={currentPage === totalPages}
                      className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {tr('下一页', 'Next')}
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'chat' && (
            <div className="mx-auto max-w-6xl p-10">
              <div className="mb-6">
                <h2 className="text-2xl font-semibold text-zinc-900">{tr('对话', 'Chat')}</h2>
                <p className="mt-1 text-sm text-zinc-400">{tr('直接描述你的需求，我会优先从收藏夹里召回相关内容，再用当前配置的 LLM 组织答案。', 'Describe what you need. I will search your bookmarks first, then use the configured LLM to compose an answer.')}</p>
              </div>

              <div className="rounded-3xl border border-zinc-200 bg-white shadow-sm">
                <div className="border-b border-zinc-200/60 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold text-zinc-900">{tr('对话列表', 'Chat threads')}</h3>
                      <p className="mt-1 text-sm text-zinc-400">{tr('新建/切换/删除对话。每个对话都会单独保存历史。', 'Create, switch, and delete threads. Each thread keeps its own history.')}</p>
                    </div>
                    <button
                      onClick={createChatThread}
                      className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 transition-colors hover:bg-zinc-100"
                      title={tr('新建对话', 'New chat')}
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="mt-4 flex items-center gap-2 overflow-x-auto">
                    {chatThreads.map((thread) => (
                      <button
                        key={thread.id}
                        onClick={() => setActiveChatId(thread.id)}
                        className={`group inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${
                          thread.id === (activeChat?.id || activeChatId)
                            ? 'border-zinc-900 bg-zinc-900 text-white'
                            : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                        }`}
                        title={thread.title}
                      >
                        <MessageSquare className="h-4 w-4 opacity-80" />
                        <span className="max-w-[160px] truncate">{thread.title}</span>
                        <span className="ml-1 text-xs opacity-70">{thread.messages.length}</span>
                        <span className="flex-1" />
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(event) => {
                            event.stopPropagation();
                            deleteChatThread(thread.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              event.stopPropagation();
                              deleteChatThread(thread.id);
                            }
                          }}
                          className={`inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                            thread.id === (activeChat?.id || activeChatId)
                              ? 'hover:bg-white/10'
                              : 'hover:bg-zinc-100'
                          }`}
                          title={tr('删除对话', 'Delete chat')}
                        >
                          <X className="h-4 w-4" />
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-3 p-5">
                  {activeMessages.map((message, index) => (
                    <div
                      key={`${message.role}-${index}`}
                      className={`max-w-[82%] rounded-2xl border p-4 text-sm leading-6 ${
                        message.role === 'user'
                          ? 'ml-auto border-zinc-900 bg-zinc-900 text-white'
                          : 'mr-auto border-zinc-200 bg-white text-zinc-800'
                      }`}
                    >
                      {message.role === 'assistant' ? renderMarkdown(message.content) : <div className="whitespace-pre-wrap">{message.content}</div>}
                    </div>
                  ))}

                  {isChatting && (
                    <div className="mr-auto max-w-[82%] rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
                      {tr('正在检索收藏并生成回答...', 'Searching bookmarks and generating an answer...')}
                    </div>
                  )}

                  <div ref={chatEndRef} />
                </div>

                <div className="border-t border-zinc-200/60 p-5">
                  <div className="flex items-center gap-2 rounded-2xl border border-zinc-200 bg-white px-3 py-2 transition-colors focus-within:border-emerald-400">
                    <textarea
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.nativeEvent as { isComposing?: boolean }).isComposing) return;
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          askBookmarks();
                        }
                      }}
                      placeholder={tr('输入问题（Enter 发送，Shift+Enter 换行）', 'Ask a question (Enter to send, Shift+Enter for a new line)')}
                      className="min-h-[40px] max-h-[120px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-zinc-900 outline-none"
                    />
                    <button
                      onClick={askBookmarks}
                      disabled={isChatting || !chatInput.trim()}
                      className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-900 text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500"
                      title={tr('发送', 'Send')}
                    >
                      {isChatting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      <span className="sr-only">{tr('发送', 'Send')}</span>
                    </button>
                  </div>
                  <p className="mt-3 text-xs text-zinc-400">{tr('使用当前设置里的 API Key、接口地址和模型。', 'Uses the API key, endpoint, and model from current settings.')}</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'trash' && (
            <div className="mx-auto max-w-6xl p-10">
              <div className="mb-6">
                <h2 className="text-2xl font-semibold text-zinc-900">{tr('垃圾箱', 'Trash')}</h2>
                <p className="mt-1 text-sm text-zinc-400">{tr('这里展示低质量内容，以及你手动标记为垃圾或失效的条目。', 'Low-quality items and entries you marked as trash or invalid appear here.')}</p>
              </div>

              <div className="mb-6 grid grid-cols-3 gap-3">
                <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-zinc-400">{tr('垃圾箱总数', 'Trash total')}</div>
                  <div className="mt-2 text-2xl font-semibold text-zinc-900">{trashItems.length}</div>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-zinc-400">{tr('低质量内容', 'Low-quality items')}</div>
                  <div className="mt-2 text-2xl font-semibold text-amber-600">{trashItems.filter((item) => item.reason === 'low_value').length}</div>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                  <div className="text-xs uppercase tracking-wide text-zinc-400">{tr('手动删除', 'Manual deletions')}</div>
                  <div className="mt-2 text-2xl font-semibold text-zinc-900">{trashItems.filter((item) => item.reason === 'manual').length}</div>
                </div>
              </div>

              {selectedTrashItem && (
                <div className="mb-6 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                  <button
                    onClick={() => setSelectedItemKey(null)}
                    className="mb-4 inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-900"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    {tr('返回列表', 'Back to list')}
                  </button>
                  <h3 className="break-words text-2xl font-semibold text-zinc-900">{selectedTrashItem.title}</h3>
                  <p className="mt-2 text-sm text-zinc-400">
                    {selectedTrashItem.reason === 'low_value'
                      ? tr('这条内容被判定为低质量，所以默认展示在垃圾箱中，但并没有被删除。', 'This item is shown in trash by default because it is low quality, but it has not been deleted.')
                      : tr('这条内容已经进入垃圾箱，后续再次导入时会自动剔除。', 'This item is in trash and will be filtered out on future imports.')}
                  </p>
                  <div className="mt-6 flex gap-3">
                    <a
                      href={selectedTrashItem.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200"
                    >
                      <Eye className="h-4 w-4" />
                      {tr('打开原文', 'Open original')}
                    </a>
                    {selectedTrashItem.reason === 'low_value' && (
                      <>
                        <button
                          onClick={() => void promoteLowQualityItem(selectedTrashItem.key, 'medium')}
                          className="rounded-xl border border-sky-500/30 px-4 py-2 text-sm text-sky-600 hover:bg-sky-500/10"
                        >
                          {tr('升为中质量', 'Upgrade to medium')}
                        </button>
                        <button
                          onClick={() => void promoteLowQualityItem(selectedTrashItem.key, 'high')}
                          className="rounded-xl border border-emerald-500/30 px-4 py-2 text-sm text-emerald-600 hover:bg-emerald-500/10"
                        >
                          {tr('升为高质量', 'Upgrade to high')}
                        </button>
                      </>
                    )}
                    {selectedTrashItem.stored && selectedTrashItem.reason !== 'low_value' && (
                      <button
                        onClick={() => restoreTrashItem(selectedTrashItem.key)}
                        className="rounded-xl border border-zinc-200 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                      >
                        {tr('恢复', 'Restore')}
                      </button>
                    )}
                    <button
                      onClick={() => void deleteItemPermanently(selectedTrashItem.key)}
                      className="rounded-xl border border-red-500/30 px-4 py-2 text-sm text-red-600 hover:bg-red-500/10"
                    >
                      {tr('清除', 'Permanently delete')}
                    </button>
                  </div>
                </div>
              )}

              <div className="rounded-3xl border border-zinc-200 bg-white shadow-sm">
                <div className="border-b border-zinc-200/60 p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold text-zinc-900">{tr('垃圾箱列表', 'Trash')}</h3>
                      <p className="mt-1 text-sm text-zinc-400">{tr('这里会展示低质量内容，以及你手动删除或校验失效的条目。', 'Low-quality items and manually deleted or invalid entries appear here.')}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void clearStoredTrash()}
                        disabled={storedTrashCount === 0}
                        className="rounded-xl border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {tr('清空垃圾箱', 'Empty trash')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteAllLowQuality()}
                        disabled={lowQualityTrashCount === 0}
                        className="rounded-xl border border-red-500/30 px-3 py-2 text-sm text-red-600 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {tr('删除全部低质量', 'Delete all low-quality')}
                      </button>
                    </div>
                  </div>
                </div>

                {pagedTrashItems.length === 0 ? (
                  <div className="p-10 text-center text-zinc-400">{tr('垃圾箱还是空的。', 'Trash is empty.')}</div>
                ) : (
                  <div className="space-y-3 p-5">
                    {pagedTrashItems.map((item) => (
                      <div key={item.key} className="flex items-center justify-between gap-4 rounded-2xl border border-zinc-200/60 bg-white p-4 transition-colors hover:border-zinc-200 hover:bg-zinc-50">
                        <div className="min-w-0">
                          <button
                            onClick={() => setSelectedItemKey(item.key)}
                            className="line-clamp-2 break-words text-left text-base font-medium text-zinc-900 hover:text-emerald-600"
                          >
                            {item.title}
                          </button>
                          <p className="mt-1 text-sm text-zinc-400">
                            {item.reason === 'low_value'
                              ? tr('低质量内容默认在这里展示，但并没有被删除。', 'Low-quality items appear here by default, but are not deleted.')
                              : tr('已加入垃圾箱，后续重复出现会自动过滤。', 'Moved to trash. Future duplicates will be filtered automatically.')}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          {item.stored && item.reason !== 'low_value' && (
                            <button
                              onClick={() => restoreTrashItem(item.key)}
                              className="rounded-xl border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                            >
                              {tr('恢复', 'Restore')}
                            </button>
                          )}
                          <button
                            onClick={() => void deleteItemPermanently(item.key)}
                            className="rounded-xl border border-red-500/30 px-3 py-2 text-sm text-red-600 hover:bg-red-500/10"
                          >
                            {tr('清除', 'Permanently delete')}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex items-center justify-between border-t border-zinc-200/60 p-4">
                  <p className="text-sm text-zinc-400">
                    {tr(`第 ${currentPage} / ${totalPages} 页`, `Page ${currentPage} / ${totalPages}`)}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                      disabled={currentPage === 1}
                      className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      {tr('上一页', 'Previous')}
                    </button>
                    <button
                      onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                      disabled={currentPage === totalPages}
                      className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {tr('下一页', 'Next')}
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'account' && (
            <div className="mx-auto max-w-6xl p-10">
              <div className="mb-6">
                <h2 className="text-2xl font-semibold text-zinc-900">{tr('账号', 'Account')}</h2>
                <p className="mt-1 text-sm text-zinc-400">{tr('在这里管理登录、会员和云同步。', 'Manage sign-in, membership, and cloud sync here.')}</p>
              </div>

              {!settings.memberToken ? (
                <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                  <h3 className="text-lg font-semibold text-zinc-900">{tr('邮箱登录', 'Email sign-in')}</h3>
                  <p className="mt-1 text-sm text-zinc-400">{tr('输入邮箱获取验证码，登录后可查看会员状态与云同步。', 'Use email verification code to sign in and manage cloud sync.')}</p>
                  <div className="mt-5 space-y-3">
                    <input
                      type="email"
                      value={memberEmailInput}
                      onChange={(e) => setMemberEmailInput(e.target.value)}
                      className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm text-zinc-900 outline-none focus:border-emerald-400"
                      placeholder={tr('输入邮箱地址', 'Enter your email')}
                    />
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={emailVerificationCodeInput}
                        onChange={(e) => setEmailVerificationCodeInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void verifyMemberEmailCodeLogin();
                        }}
                        className="flex-1 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 font-mono text-sm text-zinc-900 outline-none focus:border-emerald-400"
                        placeholder={tr('输入验证码', 'Verification code')}
                      />
                      <button
                        type="button"
                        onClick={() => void requestMemberEmailCode()}
                        disabled={isMemberBusy}
                        className="rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                      >
                        {tr('获取验证码', 'Send code')}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => void verifyMemberEmailCodeLogin()}
                      disabled={isMemberBusy}
                      className="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {tr('登录', 'Sign in')}
                    </button>
                    {memberMessage && <p className="text-sm text-zinc-500">{memberMessage}</p>}
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="flex flex-col gap-4 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-700">
                        <UserCircle className="h-7 w-7" aria-hidden />
                      </div>
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">{tr('当前账号', 'Signed in as')}</p>
                        <p className="mt-1 break-all text-lg font-semibold text-zinc-900">{settings.memberEmail || memberEmailInput || '—'}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void logoutMember()}
                      disabled={isMemberBusy}
                      className="inline-flex items-center justify-center gap-2 self-start rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 sm:self-center"
                    >
                      <LogOut className="h-4 w-4" aria-hidden />
                      {tr('退出登录', 'Sign out')}
                    </button>
                  </div>

                  <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                    <div className="mb-2 flex items-center gap-2 text-zinc-900">
                      <CreditCard className="h-5 w-5 text-emerald-600" aria-hidden />
                      <h3 className="text-lg font-semibold">{tr('会员订阅', 'Membership')}</h3>
                    </div>
                    <p className="mb-4 text-sm text-zinc-500">
                      {tr(
                        '开通会员后，可使用云端同步收藏、在设置中启用平台托管 AI（无需自备 API Key），并享受后续会员功能更新。',
                        'Membership unlocks cloud bookmark sync, hosted AI in settings without your own API key, and future member features.',
                      )}
                    </p>
                    {!memberProfile ? (
                      <p className="mb-4 text-sm text-zinc-400">
                        {isMemberBusy
                          ? tr('正在加载会员状态…', 'Loading membership…')
                          : tr('点击「刷新订阅状态」获取会员信息。', 'Tap refresh to load membership status.')}
                      </p>
                    ) : (
                      <div className="mb-4 flex items-center gap-2.5 rounded-2xl border border-zinc-100 bg-zinc-50 px-4 py-3 text-sm text-zinc-800">
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${memberProSubscriptionActive ? 'bg-emerald-500' : 'bg-zinc-300'}`} aria-hidden />
                        <span className="font-medium">
                          {memberProSubscriptionActive ? tr('会员状态：已开通', 'Member status: Active') : tr('会员状态：未开通', 'Member status: Inactive')}
                        </span>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void openMemberCheckout()}
                        disabled={isMemberBusy}
                        className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        {memberProfile && memberProSubscriptionActive ? tr('续订', 'Renew') : tr('开通', 'Subscribe')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void refreshMemberProfile()}
                        disabled={isMemberBusy}
                        className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                      >
                        <RefreshCw className="h-4 w-4" aria-hidden />
                        {tr('刷新订阅状态', 'Refresh subscription')}
                      </button>
                    </div>
                    <div className="mt-4 rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
                      <p className="text-sm font-medium text-emerald-950">{tr('邀请码兑换', 'Redeem invite code')}</p>
                      <p className="mt-1 text-xs leading-5 text-emerald-800">
                        {tr('如果你有邀请码，可以在这里直接兑换会员。', 'If you have an invite code, redeem it here to activate membership.')}
                      </p>
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <input
                          type="text"
                          value={inviteCodeInput}
                          onChange={(e) => setInviteCodeInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void redeemMemberInviteCode();
                          }}
                          className="min-w-0 flex-1 rounded-xl border border-emerald-200 bg-white px-3 py-2.5 font-mono text-sm uppercase tracking-wide text-zinc-900 outline-none focus:border-emerald-400"
                          placeholder={tr('输入邀请码', 'Enter invite code')}
                        />
                        <button
                          type="button"
                          onClick={() => void redeemMemberInviteCode()}
                          disabled={isMemberBusy}
                          className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {tr('兑换', 'Redeem')}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                    <div className="mb-2 flex items-center gap-2 text-zinc-900">
                      <Cloud className="h-5 w-5 text-sky-600" aria-hidden />
                      <h3 className="text-lg font-semibold">{tr('云端同步', 'Cloud sync')}</h3>
                    </div>
                    <p className="text-sm text-zinc-500">
                      {memberProfile?.hosted_ai_enabled
                        ? tr('云端同步已启用。收藏、已读历史与垃圾箱会自动同步。', 'Cloud sync is enabled. Collections, read history, and trash auto-sync.')
                        : tr('会员开通后可启用云端同步。', 'Cloud sync is available after membership is active.')}
                    </p>
                    {syncConflict && (
                      <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-amber-900">
                            {tr('检测到本地与云端数据冲突。请选择要保留的版本。', 'Local and cloud data conflict detected. Choose which version to keep.')}
                          </p>
                          <button
                            type="button"
                            onClick={() => setShowSyncConflictActions((v) => !v)}
                            className="rounded-lg border border-amber-300 px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
                          >
                            {showSyncConflictActions ? tr('收起', 'Hide') : tr('处理冲突', 'Resolve conflict')}
                          </button>
                        </div>
                        {showSyncConflictActions && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => void chooseLocalSyncVersion()}
                              disabled={isMemberBusy}
                              className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                            >
                              {tr('保留本地', 'Keep local')}
                            </button>
                            <button
                              type="button"
                              onClick={() => void chooseCloudSyncVersion()}
                              disabled={isMemberBusy}
                              className="rounded-xl border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                            >
                              {tr('使用云端', 'Use cloud')}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {memberMessage && <p className="mt-3 text-sm text-zinc-500">{memberMessage}</p>}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="mx-auto max-w-6xl p-10">
              <div className="mb-6">
                <h2 className="text-2xl font-semibold text-zinc-900">{tr('设置', 'Settings')}</h2>
                <p className="mt-1 text-sm text-zinc-400">{tr('把模型、访问控制和支持入口放在同一块更宽的设置面板里。', 'Manage model, access control, and support in one wider settings panel.')}</p>
              </div>

              <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
                <h3 className="mb-2 font-semibold text-zinc-900">{tr('工作台设置', 'Workspace Settings')}</h3>
                <p className="mb-6 text-sm text-zinc-400">{tr('统一管理模型接口、本地访问密码和支持入口。', 'Configure model API, local access password, and support entrypoints.')}</p>

                <div className="space-y-6">
                  <div className="space-y-4 rounded-2xl border border-zinc-200/60 bg-transparent p-5">
                    <div>
                      <h4 className="text-sm font-medium text-zinc-900">{tr('语言', 'Language')}</h4>
                      <p className="mt-1 text-sm text-zinc-400">{tr('切换界面语言（仅影响工作台页面文案）。', 'Switch UI language (affects workspace UI text only).')}</p>
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-zinc-600">{tr('界面语言', 'UI Language')}</label>
                      <select
                        value={settings.language}
                        onChange={(e) => setSettings({ ...settings, language: e.target.value as LanguagePreference })}
                        className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-zinc-900 outline-none focus:border-emerald-400"
                      >
                        <option value="auto">{tr('跟随系统', 'System')}</option>
                        <option value="zh-CN">{tr('中文', 'Chinese')}</option>
                        <option value="en">{tr('英文', 'English')}</option>
                      </select>
                    </div>
                  </div>
                  <div className="space-y-4 rounded-2xl border border-zinc-200/60 bg-transparent p-5">
                    <div>
                      <h4 className="text-sm font-medium text-zinc-900">{tr('LLM 配置', 'LLM Settings')}</h4>
                      <p className="mt-1 text-sm text-zinc-400">
                        {tr(
                          '可选择自备 API（BYOK）或会员模型；会员模型开通后无需填写 API Key。',
                          'Choose BYOK API or member-hosted model. Hosted model does not require API key.',
                        )}
                      </p>
                    </div>

                    <div>
                      <label className="mb-1 block text-sm font-medium text-zinc-600">{tr('模型来源', 'Model source')}</label>
                      <select
                        value={llmModeView.effectiveMode}
                        onChange={(e) => {
                          const selected = e.target.value === 'hosted' ? 'hosted' : 'byok';
                          setSettings({ ...settings, aiMode: selected });
                        }}
                        className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-zinc-900 outline-none focus:border-emerald-400"
                      >
                        <option value="byok">{tr('自备 API（BYOK）', 'Bring your own API (BYOK)')}</option>
                        <option value="hosted" disabled={!llmModeView.hostedAvailable}>
                          {llmModeView.hostedAvailable ? tr('会员模型（推荐）', 'Member hosted model (recommended)') : tr('会员模型（开通会员后可用）', 'Member hosted model (requires membership)')}
                        </option>
                      </select>
                      {llmModeView.upgradeHint && (
                        <p className="mt-2 text-xs text-amber-700">
                          {tr('开通会员后可直接使用会员模型，无需自备 API Key。', 'Membership unlocks hosted model access without your own API key.')}
                        </p>
                      )}
                      {!llmModeView.upgradeHint && llmModeView.effectiveMode === 'hosted' && (
                        <p className="mt-2 text-xs text-emerald-700">
                          {tr('当前使用会员模型。需要时可切回 BYOK。', 'You are using the member hosted model. You can switch back to BYOK anytime.')}
                        </p>
                      )}
                    </div>

                    {llmModeView.effectiveMode === 'byok' ? (
                      <>
                        <div>
                          <label className="mb-1 block text-sm font-medium text-zinc-600">API Key</label>
                          <input
                            type="password"
                            value={settings.apiKey || ''}
                            onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-zinc-900 outline-none focus:border-emerald-400"
                            placeholder="sk-..."
                          />
                        </div>

                        <div>
                          <label className="mb-1 block text-sm font-medium text-zinc-600">API Endpoint</label>
                          <input
                            type="text"
                            value={settings.endpoint || ''}
                            onChange={(e) => setSettings({ ...settings, endpoint: e.target.value })}
                            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-zinc-900 outline-none focus:border-emerald-400"
                            placeholder="https://openrouter.ai/api/v1/chat/completions"
                          />
                          <p className="mt-2 text-xs text-zinc-400">{tr('OpenRouter 请填写 `https://openrouter.ai/api/v1/chat/completions`。', 'For OpenRouter, use `https://openrouter.ai/api/v1/chat/completions`.')}</p>
                        </div>

                        <div>
                          <label className="mb-1 block text-sm font-medium text-zinc-600">Model</label>
                          <input
                            type="text"
                            value={settings.model || ''}
                            onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-zinc-900 outline-none focus:border-emerald-400"
                            placeholder="openai/gpt-5.2"
                          />
                        </div>
                      </>
                    ) : (
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                        {tr('会员模型已启用，后台将自动使用会员账号的托管模型。', 'Member hosted model is enabled. The extension will use your hosted model automatically.')}
                      </div>
                    )}

                    <button
                      onClick={handleTestLlmSettings}
                      disabled={isTestingLlm}
                      className="w-full rounded-xl border border-zinc-200 bg-white py-2 font-medium text-zinc-900 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
                    >
                      {isTestingLlm ? tr('测试中...', 'Testing...') : tr('测试链接', 'Test connection')}
                    </button>
                  </div>

                  <div className="space-y-4 rounded-2xl border border-zinc-200/60 bg-transparent p-5">
                    <div>
                      <h4 className="text-sm font-medium text-zinc-900">{tr('访问控制与支持', 'Access Control & Support')}</h4>
                      <p className="mt-1 text-sm text-zinc-400">{tr('可以给扩展加一个本地访问密码，也可以通过捐赠支持这个项目继续迭代。', 'Set a local access password, or support the project to keep it improving.')}</p>
                    </div>

                    <div>
                      <label className="mb-1 block text-sm font-medium text-zinc-600">{tr('访问密码', 'Password')}</label>
                      <input
                        type="password"
                        value={settings.accessPassword || ''}
                        onChange={(e) => setSettings({ ...settings, accessPassword: e.target.value })}
                        className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-zinc-900 outline-none focus:border-emerald-400"
                        placeholder={tr('为空则不启用访问密码', 'Leave empty to disable')}
                      />
                      <p className="mt-2 text-xs text-zinc-400">{tr('保存后，下次打开扩展时需要输入这个密码才能进入。', 'After saving, you will need this password to open the extension next time.')}</p>
                    </div>

                    <a
                      href="https://buy.stripe.com/5kQ4gybHj2T26Rv1Jh2sM00"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15"
                    >
                      <Sparkles className="h-4 w-4" />
                      Buy Me a Coffee
                      <ArrowUpRight className="h-4 w-4" />
                    </a>

                    <button
                      onClick={handleSaveSettings}
                      className="w-full rounded-xl border border-zinc-200 bg-white py-2 font-medium text-zinc-900 transition-colors hover:bg-zinc-100"
                    >
                      {tr('保存设置', 'Save settings')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
