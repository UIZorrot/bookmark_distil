import { callHostedChatCompletion, testHostedAiConnection } from '../backendApi';

export { };

console.log('Background service worker running...');

const APP_PAGE_URL = chrome.runtime.getURL('index.html');

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
  validatedAt?: number;
  validationStatus?: 'ok' | 'missing' | 'error' | 'skipped';
  archivedAt?: number;
  archiveFilename?: string;
}

interface CollectionRecord {
  items: BookmarkItem[];
}

interface TrashRecord {
  key: string;
  title: string;
  url: string;
  removedAt: number;
  reason: 'low_value' | 'manual' | '404_error';
}

interface Settings {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  accessPassword?: string;
  language?: 'auto' | 'zh-CN' | 'en';
  theme?: 'dark' | 'light';
  aiMode?: 'byok' | 'hosted';
  memberToken?: string;
  memberEmail?: string;
}

interface ChatContextItem {
  title: string;
  url: string;
  summary?: string;
  excerpt?: string;
  category?: string;
  tags?: string[];
  qualityScore?: number;
  qualityTier?: 'high' | 'medium' | 'low' | 'unclassified';
  recommendationReason?: string;
}

type ProcessingOptions = {
  validate: boolean;
  analyze: boolean;
  rescan?: boolean;
};

type ValidationResult =
  | { remove: true }
  | {
    remove: false;
    patch: Partial<Pick<BookmarkItem, 'validatedAt' | 'validationStatus' | 'archiveFilename' | 'archivedAt'>>;
  };

function usesHostedAi(settings: Settings) {
  return settings.aiMode === 'hosted' && Boolean(settings.memberToken?.trim());
}

function hasLlmAccess(settings: Settings) {
  return usesHostedAi(settings) || Boolean(settings.apiKey?.trim());
}

function getBookmarkKey(url: string) {
  let key = url.trim().toLowerCase();
  try {
    const urlObj = new URL(url);
    urlObj.hash = '';
    urlObj.search = '';
    key = `${urlObj.origin}${urlObj.pathname}`.toLowerCase();
  } catch {
    // ignore
  }
  return key;
}

function getQualityTier(score?: number, tier?: 'high' | 'medium' | 'low' | 'unclassified') {
  if (tier) return tier;
  if (typeof score !== 'number') return undefined;
  if (score >= 8) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

const MEDIA_TAGS_HINT = '【包含图片或视频】请根据需要自行完善标签。';

function stripWhitespaceLen(text: string) {
  return (text || '').replace(/\s/g, '').length;
}

function bookmarkIsMostlyVisualMedia(item: BookmarkItem) {
  if (!item.containsImage && !item.containsVideo) return false;
  return stripWhitespaceLen(item.excerpt) < 80;
}

function attachMediaRecommendationNote(reason?: string) {
  const note = MEDIA_TAGS_HINT;
  if (!reason) return note;
  if (reason.includes('包含图片或视频')) return reason;
  return `${reason.trim()}\n${note}`;
}

/** Image/video-heavy items → 未分类 + unclassified tier; otherwise keep LLM output but annotate media hint. */
function finalizeMediaBookmarkPresentation(item: BookmarkItem): BookmarkItem {
  const hasMedia = Boolean(item.containsImage || item.containsVideo);
  if (!hasMedia) return item;

  let next: BookmarkItem = {
    ...item,
    recommendationReason: attachMediaRecommendationNote(item.recommendationReason),
  };

  const heavy = bookmarkIsMostlyVisualMedia(next);

  if (heavy) {
    if (!next.manualCategoryLocked) {
      next = {
        ...next,
        category: '未分类',
        tags: [],
      };
    }
    if (!next.manualQualityLocked) {
      next = {
        ...next,
        qualityTier: 'unclassified',
        qualityScore: undefined,
      };
    }
  }

  return next;
}

function normalizeLlmEndpoint(endpoint?: string) {
  const fallback = 'https://api.openai.com/v1/chat/completions';
  const raw = endpoint?.trim();
  if (!raw) return { url: fallback };

  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, '');

    if (hostname === 'openrouter.ai') {
      if (pathname.startsWith('/docs')) {
        return {
          error: '你填的是 OpenRouter 文档地址，不是接口地址。请使用 `https://openrouter.ai/api/v1/chat/completions`。',
        };
      }

      if (pathname === '' || pathname === '/' || pathname === '/api' || pathname === '/api/v1') {
        parsed.pathname = '/api/v1/chat/completions';
        parsed.search = '';
        return { url: parsed.toString() };
      }
    }

    if (pathname === '/v1' || pathname === '/api/v1') {
      parsed.pathname = `${pathname}/chat/completions`;
      parsed.search = '';
      return { url: parsed.toString() };
    }

    return { url: parsed.toString() };
  } catch {
    return {
      error: 'API Endpoint 不是合法 URL。',
    };
  }
}

function buildLlmHeaders(endpoint: string, apiKey: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  try {
    const parsed = new URL(endpoint);
    if (parsed.hostname.toLowerCase() === 'openrouter.ai') {
      headers['HTTP-Referer'] = 'https://openrouter.ai/';
      headers['X-OpenRouter-Title'] = 'Bookmark Distil';
    }
  } catch {
    // ignore invalid url here; validation happens elsewhere
  }

  return headers;
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function testLLMConnection(settings: Settings) {
  if (settings.aiMode === 'hosted') {
    if (!settings.memberToken?.trim()) {
      return { status: 'error' as const, message: '请先登录账号，或切回 BYOK 模式。' };
    }

    const hosted = await testHostedAiConnection({ token: settings.memberToken });

    if (hosted.status === 'ok') {
      const provider = hosted.provider?.trim();
      const model = hosted.model?.trim();
      const suffix = provider || model ? `（${[provider, model].filter(Boolean).join(' / ')}）` : '';
      return { status: 'ok' as const, message: `平台托管 AI 可用${suffix}。` };
    }

    return { status: 'error' as const, message: `平台托管 AI 不可用：${hosted.message}` };
  }

  const apiKey = settings.apiKey?.trim();
  const model = settings.model?.trim() || 'gpt-3.5-turbo';
  const normalizedEndpoint = normalizeLlmEndpoint(settings.endpoint);

  if (!apiKey) {
    return { status: 'error' as const, message: '请先填写 API Key。' };
  }

  if ('error' in normalizedEndpoint) {
    return { status: 'error' as const, message: normalizedEndpoint.error };
  }

  const endpoint = normalizedEndpoint.url;

  try {
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: buildLlmHeaders(endpoint, apiKey),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with a short plain text: OK' }],
        temperature: 0,
        max_tokens: 16,
      }),
    });

    const raw = await response.text();
    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      return {
        status: 'error' as const,
        message: `接口返回错误：${response.status} ${response.statusText || ''}`.trim(),
      };
    }

    if (!raw.trim()) {
      return {
        status: 'error' as const,
        message: '接口已响应，但返回内容为空。',
      };
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return {
        status: 'error' as const,
        message: contentType.includes('text/html')
          ? '接口返回的是 HTML，不是模型 JSON。请检查 endpoint，OpenRouter 应使用 `https://openrouter.ai/api/v1/chat/completions`。'
          : '接口已响应，但返回内容不是合法 JSON。请检查 endpoint 是否是正确的 chat/completions 地址。',
      };
    }

    const content = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;
    if (content) {
      return {
        status: 'ok' as const,
        message: `测试成功：已收到模型响应（${model}）。`,
      };
    }

    return {
      status: 'error' as const,
      message: '接口已响应，但返回结构不是兼容的 chat/completions 格式。',
    };
  } catch (error) {
    console.error('LLM test error:', error);
    const endpointHost = (() => {
      try {
        return new URL(endpoint).hostname;
      } catch {
        return endpoint;
      }
    })();
    return {
      status: 'error' as const,
      message:
        endpointHost === 'openrouter.ai'
          ? '请求没有成功发到 OpenRouter。请确认 endpoint 为 `https://openrouter.ai/api/v1/chat/completions`，然后刷新扩展后重试。'
          : '请求失败，请检查 endpoint、网络、扩展权限和 API Key。',
    };
  }
}

async function callLLM(item: BookmarkItem, settings: Settings): Promise<Partial<BookmarkItem> | null> {
  const prompt = `
Please analyze the following saved bookmark content:
Title: ${item.title}
Excerpt: ${item.excerpt}
Author: ${item.author}
Page flags: containsImage=${Boolean(item.containsImage)}, containsVideo=${Boolean(item.containsVideo)}

Provide a JSON output with the following fields:
1. "summary": A quick 1-2 sentence summary of what this is about.
2. "category": A broad category (e.g., Technology, Lifestyle, Science, Fiction, Career, etc.). Use "未分类" when the substantive written excerpt is very short/minimal primarily because visuals carry the meaning; the UI will finalize this when appropriate.
3. "tags": An array of 8-12 specific, search-friendly tags. Prefer concrete topics, methods, products, frameworks, people, companies, use-cases, and problems solved. If the excerpt is too short mainly because visuals carry the meaning, respond with [] (empty array) so the user can tag manually later.
4. "qualityScore": A score from 1 to 10 estimating the quality/depth of the content based on the title and excerpt.
5. "qualityTier": One of "high", "medium", "low". Use: 8-10 => high, 5-7 => medium, 1-4 => low. If the bookmark is mainly an image/video post with too little text to judge, keep the score conservative and prefer "low" unless the written text clearly signals depth.
6. "recommendationReason": A short reason why the user should read this (especially if qualityTier is high or medium).

Quality principles (very important):
- "low" (1-4): content that is trivial / common sense, can be answered by asking AI directly, or can be found easily by a quick search. Also low if it's clickbait, shallow listicles, pure announcements without insights, or too little information.
- "medium" (5-7): useful but not deep. A solid overview, tutorial, or practical notes with some value, but not rare/insightful enough to be "high".
- "high" (8-10): non-trivial, insightful, original, or highly actionable. Includes deep reasoning, unique experience, high-signal summaries, strong examples, or references worth keeping.

Output ONLY valid JSON.
  `;

  if (usesHostedAi(settings)) {
    const hosted = await callHostedChatCompletion(
      { token: settings.memberToken },
      {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      },
    );

    if (hosted.status !== 'ok') {
      console.error('Hosted LLM error:', hosted.message);
      return null;
    }

    try {
      const jsonStr = hosted.answer.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(jsonStr) as Partial<BookmarkItem>;
    } catch (error) {
      console.error('Hosted LLM JSON parse error:', error);
      return null;
    }
  }

  const apiKey = settings.apiKey?.trim() || '';
  const endpoint = settings.endpoint || '';
  const model = settings.model || '';

  try {
    const normalizedEndpoint = normalizeLlmEndpoint(endpoint);
    if ('error' in normalizedEndpoint) {
      console.error('LLM endpoint error:', normalizedEndpoint.error);
      return null;
    }

    const response = await fetchWithTimeout(normalizedEndpoint.url, {
      method: 'POST',
      headers: buildLlmHeaders(normalizedEndpoint.url, apiKey),
      body: JSON.stringify({
        model: model || 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      }),
    });

    const data = await response.json();
    if (data.choices && data.choices.length > 0) {
      const content = data.choices[0].message.content;
      const jsonStr = content.replace(/```json/g, '').replace(/```/g, '').trim();
      const result = JSON.parse(jsonStr);
      return result;
    }
  } catch (error) {
    console.error('LLM API error:', error);
  }
  return null;
}

function mergeRecommendationReason(primary?: string, secondary?: string) {
  const a = primary?.trim();
  const b = secondary?.trim();
  if (a && b && a.includes(b)) return a;
  if (a && b && b.includes(a)) return b;
  if (!a) return secondary;
  if (!b) return primary;
  return `${a}\n${b}`;
}

function mergeRescanResult(item: BookmarkItem, analysis: Partial<BookmarkItem>): BookmarkItem {
  const shouldPreserveCategory =
    item.manualCategoryLocked ||
    getQualityTier(item.qualityScore, item.qualityTier) === 'high';

  return {
    ...item,
    analyzed: true,
    summary: item.summary || analysis.summary,
    category: shouldPreserveCategory ? item.category : (analysis.category || item.category),
    tags: analysis.tags || item.tags,
    qualityScore: item.manualQualityLocked ? item.qualityScore : (item.qualityScore ?? analysis.qualityScore),
    qualityTier: item.manualQualityLocked ? item.qualityTier : (item.qualityTier || analysis.qualityTier),
    recommendationReason: mergeRecommendationReason(item.recommendationReason, analysis.recommendationReason),
  };
}

async function answerFromBookmarks(
  question: string,
  contexts: ChatContextItem[],
  settings: Settings
) {
  const contextBlock = contexts
    .map((item, index) => {
      const tags = item.tags?.join(', ') || '无';
      return [
        `#${index + 1}`,
        `标题: ${item.title}`,
        `链接: ${item.url}`,
        `分类: ${item.category || '未分类'}`,
        `质量: ${item.qualityTier || 'unknown'} / ${item.qualityScore ?? '无评分'}`,
        `标签: ${tags}`,
        `摘要: ${item.summary || item.excerpt || '无摘要'}`,
        `推荐理由: ${item.recommendationReason || '无'}`,
      ].join('\n');
    })
    .join('\n\n');

  const prompt = `
你是用户的收藏检索助手。请只基于给定的收藏上下文回答问题，不要编造不存在的收藏。

用户问题:
${question}

收藏上下文:
${contextBlock || '无'}

输出要求:
1. 先直接回答用户问题。
2. 如果找到了匹配收藏，列出 1-5 条最相关结果。
3. 每条结果都包含：标题、为什么相关、链接。
4. 如果上下文不足，请明确说“当前收藏中没有足够信息”。
`;

  if (usesHostedAi(settings)) {
    const hosted = await callHostedChatCompletion(
      { token: settings.memberToken },
      {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      },
    );

    if (hosted.status === 'ok') {
      return { status: 'ok' as const, answer: hosted.answer };
    }

    return { status: 'error' as const, message: `平台托管 AI 请求失败：${hosted.message}。你可以切回 BYOK 模式继续使用。` };
  }

  const apiKey = settings.apiKey?.trim();
  const normalizedEndpoint = normalizeLlmEndpoint(settings.endpoint);
  const model = settings.model?.trim() || 'gpt-3.5-turbo';

  if (!apiKey) {
    return { status: 'error' as const, message: '请先在设置中填写 LLM API Key。' };
  }

  if ('error' in normalizedEndpoint) {
    return { status: 'error' as const, message: normalizedEndpoint.error };
  }

  try {
    const response = await fetchWithTimeout(normalizedEndpoint.url, {
      method: 'POST',
      headers: buildLlmHeaders(normalizedEndpoint.url, apiKey),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      return {
        status: 'error' as const,
        message: `对话请求失败：${response.status} ${response.statusText || ''}`.trim(),
      };
    }

    const data = await response.json();
    const content = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;

    if (!content) {
      return { status: 'error' as const, message: '模型已响应，但没有返回可用内容。' };
    }

    return { status: 'ok' as const, answer: content };
  } catch (error) {
    console.error('Bookmark chat error:', error);
    return { status: 'error' as const, message: '对话请求失败，请检查当前 LLM 配置是否可用。' };
  }
}

function sanitizeFilename(input: string) {
  const normalized = Array.from(input)
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code < 32) return '-';
      if ('<>:"/\\|?*'.includes(char)) return '-';
      return char;
    })
    .join('');

  return normalized
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'bookmark';
}

function htmlToPlainText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|article|section|li|h1|h2|h3|h4|h5|h6|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractFocusedContent(html: string) {
  const patterns = [
    /data-testid="tweetText"[^>]*>([\s\S]*?)<\/div>/gi,
    /class="[^"]*RichContent-inner[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    /class="[^"]*RichText[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    /<article[\s\S]*?>([\s\S]*?)<\/article>/gi,
    /<p[^>]*>([\s\S]*?)<\/p>/gi,
  ];

  const pieces: string[] = [];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const text = htmlToPlainText(match[1]);
      if (text.length >= 40) {
        pieces.push(text);
      }
      if (pieces.length >= 12) break;
    }
    if (pieces.length >= 12) break;
  }

  return Array.from(new Set(pieces)).slice(0, 8).join('\n\n');
}

function buildMarkdown(item: BookmarkItem, finalUrl: string, focusedContent: string) {
  const parts = [
    `# ${item.title}`,
    '',
    `- URL: ${finalUrl}`,
    `- Author: ${item.author}`,
    `- Archived At: ${new Date().toISOString()}`,
  ];

  if (item.category) parts.push(`- Category: ${item.category}`);
  if (item.tags?.length) parts.push(`- Tags: ${item.tags.join(', ')}`);
  if (typeof item.qualityScore === 'number') parts.push(`- Quality Score: ${item.qualityScore}/10`);

  parts.push('');
  parts.push('## Summary');
  parts.push('');
  parts.push(item.summary || item.excerpt || 'No summary available.');
  parts.push('');

  if (item.recommendationReason) {
    parts.push('## Recommendation');
    parts.push('');
    parts.push(item.recommendationReason);
    parts.push('');
  }

  if (focusedContent) {
    parts.push('## Extracted Content');
    parts.push('');
    parts.push(focusedContent.slice(0, 12000));
    parts.push('');
  }

  return parts.join('\n');
}

async function saveMarkdownToDownloads(item: BookmarkItem, finalUrl: string, html: string) {
  const focusedContent = extractFocusedContent(html) || item.summary || item.excerpt || '';
  const markdown = buildMarkdown(item, finalUrl, focusedContent);
  const filename = `BookmarkDistil/archives/${sanitizeFilename(item.title)}-${Date.now()}.md`;
  await chrome.downloads.download({
    url: `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  return filename;
}

async function validateAndArchiveItem(item: BookmarkItem) {
  try {
    const parsedUrl = new URL(item.url.trim());
    if (parsedUrl.protocol !== 'https:') {
      return {
        remove: false as const,
        patch: {
          validatedAt: Date.now(),
          validationStatus: 'skipped' as const,
        },
      };
    }
  } catch {
    return {
      remove: false as const,
      patch: {
        validatedAt: Date.now(),
        validationStatus: 'skipped' as const,
      },
    };
  }

  try {
    const response = await fetch(item.url, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'include',
    });

    if (response.status === 404) {
      return { remove: true as const };
    }

    if (!response.ok) {
      return {
        remove: false as const,
        patch: {
          validatedAt: Date.now(),
          validationStatus: 'error' as const,
        },
      };
    }

    const html = await response.text();
    let archiveFilename = item.archiveFilename;
    let archivedAt = item.archivedAt;

    if (!item.archiveFilename) {
      archiveFilename = await saveMarkdownToDownloads(item, response.url || item.url, html);
      archivedAt = Date.now();
    }

    return {
      remove: false as const,
      patch: {
        validatedAt: Date.now(),
        validationStatus: 'ok' as const,
        archiveFilename,
        archivedAt,
      },
    };
  } catch (error) {
    console.error('Validation/archive error:', error);
    return {
      remove: false as const,
      patch: {
        validatedAt: Date.now(),
        validationStatus: 'error' as const,
      },
    };
  }
}

type BgJobPhase = 'analysis' | 'revalidate' | 'rescan';

type BgJobStatus =
  | { state: 'idle' }
  | { state: 'running'; phase: BgJobPhase; processed: number; total: number; startedAt: number };

function jobPhase(options: ProcessingOptions): BgJobPhase {
  if (options.validate) return 'revalidate';
  if (options.rescan) return 'rescan';
  return 'analysis';
}

function countQueuedWork(
  collections: Record<string, CollectionRecord>,
  settings: Settings,
  options: ProcessingOptions,
): number {
  const hasAccess = hasLlmAccess(settings);
  let n = 0;
  for (const col of Object.values(collections)) {
    for (const item of col.items) {
      if (options.validate) n += 1;
      else if (options.analyze && !item.analyzed && hasAccess) n += 1;
      else if (options.rescan && hasAccess) n += 1;
    }
  }
  return n;
}

let processJobChain = Promise.resolve();

function enqueueProcessCollections(options: ProcessingOptions) {
  processJobChain = processJobChain
    .then(() => processCollections(options))
    .catch((error) => {
      console.error('processCollections:', error);
    });
}

let lastBgJobPublish = 0;

async function publishBgJob(status: BgJobStatus, force?: boolean) {
  const now = Date.now();
  if (!force && status.state === 'running' && status.processed < status.total && now - lastBgJobPublish < 240) return;
  lastBgJobPublish = now;
  await chrome.storage.local.set({ bgJobStatus: status });
}

async function processCollections(options: ProcessingOptions) {
  const startedAt = Date.now();
  const data = await chrome.storage.local.get(['collections', 'settings', 'trashIndex']);
  const collections = (data.collections || {}) as Record<string, CollectionRecord>;
  const settings = (data.settings || {}) as Settings;
  const trashIndex = (data.trashIndex || {}) as Record<string, TrashRecord>;

  const phase = jobPhase(options);
  const totalUnits = countQueuedWork(collections, settings, options);

  if (totalUnits <= 0) {
    await publishBgJob({ state: 'idle' }, true);
    return;
  }

  await publishBgJob({ state: 'running', phase, processed: 0, total: totalUnits, startedAt }, true);

  let processed = 0;
  let updated = false;

  for (const colId of Object.keys(collections)) {
    const col = collections[colId];
    for (let i = 0; i < col.items.length; i++) {
      const item = col.items[i];
      const llmReady = hasLlmAccess(settings);
      let validation: ValidationResult = {
        remove: false as const,
        patch: {},
      };

      if (options.validate) {
        validation = await validateAndArchiveItem(item);
        processed += 1;
        await publishBgJob({ state: 'running', phase, processed, total: totalUnits, startedAt });
      }

      if (validation.remove) {
        // AI/System only "deletes" (moves to trash), never "clears" permanently
        const key = getBookmarkKey(item.url);

        trashIndex[key] = {
          key,
          title: item.title,
          url: item.url,
          removedAt: Date.now(),
          reason: '404_error',
        };
        col.items.splice(i, 1);
        i -= 1;
        updated = true;
        await chrome.storage.local.set({ trashIndex, collections });
        continue;
      }

      const persistedSnapshot = JSON.stringify(item);
      const seededItem: BookmarkItem = { ...item, ...validation.patch };
      let nextItem: BookmarkItem = seededItem;

      if (options.analyze && !nextItem.analyzed && llmReady) {
        console.log(`Analyzing item: ${nextItem.title}`);
        const analysis = await callLLM(nextItem, settings);
        if (analysis) {
          nextItem = mergeRescanResult(nextItem, analysis);
          updated = true;
        }
        processed += 1;
        await publishBgJob({ state: 'running', phase, processed, total: totalUnits, startedAt });
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (options.rescan && llmReady) {
        console.log(`Rescanning item: ${nextItem.title}`);
        const analysis = await callLLM(nextItem, settings);
        if (analysis) {
          nextItem = mergeRescanResult(nextItem, analysis);
          updated = true;
        }
        processed += 1;
        await publishBgJob({ state: 'running', phase, processed, total: totalUnits, startedAt });
        await new Promise((r) => setTimeout(r, 1000));
      }

      nextItem = finalizeMediaBookmarkPresentation(nextItem);
      if (JSON.stringify(nextItem) !== persistedSnapshot) updated = true;

      col.items[i] = nextItem;
      if (updated) {
        await chrome.storage.local.set({ collections });
      }
    }
  }

  await publishBgJob({ state: 'idle' }, true);
}

type BackgroundRequest =
  | { type: 'TEST' }
  | { type: 'TEST_LLM'; settings: Settings }
  | { type: 'ASK_BOOKMARKS'; question: string; contexts: ChatContextItem[] }
  | { type: 'CRAWL_FINISHED'; collectionId: string }
  | { type: 'START_ANALYSIS' }
  | { type: 'START_RESCAN' }
  | { type: 'REVALIDATE_ALL' };

type BackgroundMessage = { type: string;[key: string]: unknown };

function isBackgroundMessage(value: unknown): value is BackgroundMessage {
  if (!value || typeof value !== 'object') return false;
  if (!('type' in value)) return false;
  return typeof (value as { type?: unknown }).type === 'string';
}

chrome.runtime.onMessage.addListener((request: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
  if (!isBackgroundMessage(request)) return;
  const typed = request as BackgroundRequest;

  if (typed.type === 'TEST') {
    sendResponse({ status: 'ok' });
    return;
  }
  if (typed.type === 'TEST_LLM') {
    void testLLMConnection(typed.settings).then(sendResponse);
    return true;
  }
  if (typed.type === 'ASK_BOOKMARKS') {
    void chrome.storage.local.get(['settings']).then((data) => {
      const settings = (data.settings || {}) as Settings;
      return answerFromBookmarks(typed.question, typed.contexts, settings);
    }).then(sendResponse);
    return true;
  }
  if (typed.type === 'CRAWL_FINISHED') {
    enqueueProcessCollections({ validate: false, analyze: true });
    sendResponse({ status: 'processing_started' });
    return;
  }
  if (typed.type === 'START_ANALYSIS') {
    enqueueProcessCollections({ validate: false, analyze: true });
    sendResponse({ status: 'started' });
    return;
  }
  if (typed.type === 'START_RESCAN') {
    enqueueProcessCollections({ validate: false, analyze: false, rescan: true });
    sendResponse({ status: 'started' });
    return;
  }
  if (typed.type === 'REVALIDATE_ALL') {
    enqueueProcessCollections({ validate: true, analyze: false });
    sendResponse({ status: 'started' });
    return;
  }
});

chrome.action.onClicked.addListener(async () => {
  const existingTabs = await chrome.tabs.query({ url: APP_PAGE_URL });
  const appTab = existingTabs[0];

  if (appTab?.id) {
    await chrome.tabs.update(appTab.id, { active: true });
    if (typeof appTab.windowId === 'number') {
      await chrome.windows.update(appTab.windowId, { focused: true });
    }
    return;
  }

  await chrome.tabs.create({ url: APP_PAGE_URL });
});
