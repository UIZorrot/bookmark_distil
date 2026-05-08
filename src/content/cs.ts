interface BookmarkItem {
  title: string;
  url: string;
  excerpt: string;
  author: string;
  addedAt: number;
  qualityTier?: 'high' | 'medium' | 'low' | 'unclassified';
  containsImage?: boolean;
  containsVideo?: boolean;
}

interface Collection {
  id: string;
  name: string;
  items: BookmarkItem[];
  lastUpdated: number;
}

interface CrawlState {
  collectionId: string;
  items: BookmarkItem[];
  page: number;
  isCrawling: boolean;
}

interface PendingImport {
  collectionId: string;
  url: string;
  requestedAt: number;
}

interface TrashRecord {
  key: string;
  title: string;
  url: string;
  removedAt: number;
  reason: 'low_value' | 'manual';
}

type Platform = 'zhihu' | 'x' | 'xiaohongshu';

type NextPageControl =
  | { kind: 'anchor'; element: HTMLAnchorElement }
  | { kind: 'button'; element: HTMLButtonElement };

interface CrawlOverlayState {
  title: string;
  detail: string;
  tone?: 'active' | 'success' | 'warning';
}

interface SourceContext {
  platform: Platform;
  collectionId: string;
  name: string;
}

console.log('Bookmark Distil content script loaded.');
document.documentElement.setAttribute('data-bookmark-distil-extension-id', chrome.runtime.id);

let crawlOverlayHideTimer: number | null = null;

function safeRuntimeSendMessage(message: { type: string; [key: string]: unknown }) {
  chrome.runtime.sendMessage(message, () => {
    void chrome.runtime.lastError;
  });
}

safeRuntimeSendMessage({ type: 'CONTENT_SCRIPT_LOADED' });

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, options: { timeoutMs: number; pollMs?: number }): Promise<boolean> {
  const poll = options.pollMs ?? 150;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(poll);
  }
  return false;
}

/** 平滑滚动结束后再判断懒加载（无 scrollend 时退化为上限等待） */
async function waitForScrollMotionEnd(scrollMotionTarget?: HTMLElement | null): Promise<void> {
  const fallback = document.scrollingElement ?? document.documentElement;
  const primary = scrollMotionTarget ?? fallback;
  await Promise.race([
    new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      primary.addEventListener('scrollend', finish, { once: true, passive: true });
      if (primary !== fallback) {
        fallback.addEventListener('scrollend', finish, { once: true, passive: true });
      }
      window.addEventListener('scrollend', finish, { once: true, passive: true });
    }),
    delay(2400),
  ]);
}

/**
 * 小红书主滚动往往在 #app / .channel-scroll-container 上，而不是 window。
 * 只滚 window 时底部懒加载可能永远不触发。
 */
function resolveInfiniteFeedScrollTarget(context: SourceContext): HTMLElement {
  if (context.platform === 'xiaohongshu') {
    const feedRoot = findXhsFeedRoot();
    const tabPanel = feedRoot.closest('.tab-content-item') as HTMLElement | null;
    const tabPanelStyle = tabPanel ? window.getComputedStyle(tabPanel) : null;
    if (tabPanel && tabPanelStyle && /^(auto|scroll|overlay)$/i.test(tabPanelStyle.overflowY || '')) {
      return tabPanel;
    }
    let el: HTMLElement | null = feedRoot;
    for (let depth = 0; depth < 16 && el; depth += 1) {
      const st = window.getComputedStyle(el);
      const oy = st.overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 8) {
        return el;
      }
      el = el.parentElement;
    }
    for (const sel of ['#app', '.channel-scroll-container', 'main']) {
      const n = document.querySelector(sel) as HTMLElement | null;
      if (n && n.scrollHeight > n.clientHeight + 8) return n;
    }
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}

function scrollInfiniteFeedToEnd(context: SourceContext): HTMLElement {
  const target = resolveInfiniteFeedScrollTarget(context);
  const fallback = (document.scrollingElement ?? document.documentElement) as HTMLElement;
  // 小红书：平滑滚动常被中途布局打断，扩展内用 instant 更可靠触达底部以触发懒加载
  const behavior: ScrollBehavior = context.platform === 'xiaohongshu' ? 'auto' : 'smooth';
  const scrollOneTarget = (el: HTMLElement) => {
    el.scrollTo({ top: el.scrollHeight, behavior });
    if (context.platform === 'xiaohongshu') {
      el.scrollTop = el.scrollHeight;
    }
  };
  const scrollOnce = () => {
    scrollOneTarget(target);
    if (context.platform === 'xiaohongshu' && fallback !== target) {
      scrollOneTarget(fallback);
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
    }
  };
  scrollOnce();
  if (context.platform === 'xiaohongshu') {
    requestAnimationFrame(() => {
      scrollOnce();
      window.setTimeout(scrollOnce, 150);
    });
  }
  return target;
}

function xhsFeedsLoadingIsVisible(el: Element): boolean {
  const h = el as HTMLElement;
  if (h.classList.contains('active')) return true;
  const cs = getComputedStyle(h);
  return cs.visibility === 'visible' && cs.display !== 'none' && Number.parseFloat(cs.opacity || '1') > 0.05;
}

/** 收藏列表外的 `.feeds-loading` 与 feeds 是兄弟节点，必须在 tab 列容器内一起查 */
function getXhsFeedColumnScope(feedRoot: HTMLElement): HTMLElement {
  return (feedRoot.closest('.tab-content-item') ?? feedRoot.closest('.feeds-tab-container') ?? feedRoot) as HTMLElement;
}

/** 站点仍在拉取更多列表内容（有则不应结束首轮/也不应判定「本轮加载完毕」） */
function feedIsLoadingMore(context: SourceContext): boolean {
  if (context.platform === 'xiaohongshu') {
    const r = findXhsFeedRoot();
    const scope = getXhsFeedColumnScope(r);
    // 占位 .feeds-loading 常留在 DOM 里且默认隐藏；仅 .active 或实际可见时表示在拉取
    for (const el of Array.from(scope.querySelectorAll('.feeds-loading'))) {
      if (xhsFeedsLoadingIsVisible(el)) return true;
    }
    return false;
  }
  if (context.platform === 'x') {
    const col = document.querySelector('[data-testid="primaryColumn"]');
    if (!col) return false;
    return Boolean(
      col.querySelector('[aria-label*="Loading" i]') ||
        col.querySelector('[role="progressbar"]') ||
        col.querySelector('[data-testid="spinner"]'),
    );
  }
  if (context.platform === 'zhihu') {
    const bar = document.querySelector('.LoadingBar');
    return Boolean(bar && (bar as HTMLElement).className.includes('is-active'));
  }
  return false;
}

/** 收藏流已渲染出可抓取条目，或明确为空且非加载中（避免死等固定秒数） */
function feedLooksEmptyAndSettled(context: SourceContext): boolean {
  if (context.platform === 'xiaohongshu') {
    const r = findXhsFeedRoot();
    const scope = getXhsFeedColumnScope(r);
    if (Array.from(scope.querySelectorAll('.feeds-loading')).some((el) => xhsFeedsLoadingIsVisible(el))) return false;
    if (r.querySelector('section.note-item, .note-item:not(.query-note-item)')) return false;
    return Boolean(r.querySelector('.empty-container, .empty-text, .empty'));
  }
  if (context.platform === 'x') {
    if (document.querySelector('article[data-testid="tweet"]')) return false;
    return Boolean(document.querySelector('[data-testid="emptyState"]'));
  }
  if (context.platform === 'zhihu') {
    if (document.querySelector('.ContentItem, .List-item')) return false;
    const bar = document.querySelector('.LoadingBar');
    const busy = Boolean(bar && (bar as HTMLElement).className.includes('is-active'));
    if (busy) return false;
    const root = document.querySelector('.CollectionDetail, main') || document.body;
    const t = root.textContent || '';
    return /收藏夹为空|还没有任何内容|共\s*0\s*条内容/.test(t);
  }
  return false;
}

async function waitForScrapeableContent(context: SourceContext): Promise<void> {
  await waitUntil(
    () =>
      (extractItemsFromPage(context).length > 0 && !feedIsLoadingMore(context)) ||
      feedLooksEmptyAndSettled(context),
    { timeoutMs: 60000, pollMs: 120 },
  );
}

type FeedUpdateOptions = { scrolled?: boolean; scrollMotionTarget?: HTMLElement | null };

/**
 * 翻页 / 下拉后：等到条数增加；若无增加则须在「曾出现加载态或已过宽限期」且「无加载 + 条数稳定」后才认为本轮结束。
 * 避免：一滚到底立刻误判、或首屏只出一半就当成抓完。
 */
async function waitForFeedUpdate(
  context: SourceContext,
  previousSignature: string,
  previousItemCount: number,
  options?: FeedUpdateOptions,
): Promise<boolean> {
  const scrolled = options?.scrolled ?? false;
  if (scrolled) {
    await waitForScrollMotionEnd(options?.scrollMotionTarget);
    await delay(200);
  }

  const t0 = Date.now();
  const deadline = t0 + 55000;
  const poll = 220;
  let sawLoading = false;
  let stableRounds = 0;
  let lastCount = -1;
  let sawScrollProgress = false;
  let lastScrollTop = -1;

  while (Date.now() < deadline) {
    await delay(poll);
    const count = extractItemsFromPage(context).length;
    const sig = getPageSignature(context);
    const loading = feedIsLoadingMore(context);
    if (scrolled && context.platform === 'xiaohongshu') {
      const t = options?.scrollMotionTarget ?? null;
      if (t) {
        const st = (t as HTMLElement).scrollTop;
        if (lastScrollTop >= 0 && Math.abs(st - lastScrollTop) > 4) sawScrollProgress = true;
        lastScrollTop = st;
      }
    }

    if (!scrolled && sig && previousSignature && sig !== previousSignature && count > 0) {
      return true;
    }

    if (loading) sawLoading = true;

    if (count > previousItemCount) return true;

    /** 小红书虚拟列表：条数不变但视口内笔记已替换，签名会变 */
    if (
      scrolled &&
      context.platform === 'xiaohongshu' &&
      sig &&
      previousSignature &&
      sig !== previousSignature &&
      count > 0
    ) {
      return true;
    }

    const minQuietMs = scrolled ? (context.platform === 'xiaohongshu' ? 4200 : 2200) : 900;
    const needStableRounds = context.platform === 'xiaohongshu' ? 16 : 8;
    // 小红书：虚拟列表 + 图片解码会让条数/签名短暂稳定；仅在“确实发生过滚动推进或见过 loading”后才允许稳定判停
    const allowStableStop =
      Date.now() - t0 >= minQuietMs &&
      (context.platform !== 'xiaohongshu' || sawScrollProgress || sawLoading) &&
      (sawLoading || Date.now() - t0 >= 9000);

    if (!loading) {
      if (count === lastCount && count > 0) stableRounds += 1;
      else stableRounds = 0;
      lastCount = count;

      if (allowStableStop && stableRounds >= needStableRounds) {
        return false;
      }
    } else {
      stableRounds = 0;
    }
  }

  const finalCount = extractItemsFromPage(context).length;
  if (finalCount > previousItemCount) return true;
  if (scrolled && context.platform === 'xiaohongshu' && finalCount > 0) {
    const finalSig = getPageSignature(context);
    return Boolean(finalSig && finalSig !== previousSignature);
  }
  return false;
}

function cleanText(text: string) {
  return text.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
}

function getElementViewportVisibleArea(el: Element | null) {
  if (!(el instanceof HTMLElement)) return 0;
  const rect = el.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  return visibleWidth * visibleHeight;
}

function normalizeUrl(url: string) {
  if (!url) return '';
  if (url.startsWith('//')) return `${window.location.protocol}${url}`;
  if (url.startsWith('/')) return `${window.location.origin}${url}`;
  return url;
}

function getBookmarkKey(url: string) {
  try {
    const parsed = new URL(normalizeUrl(url));
    parsed.hash = '';
    parsed.search = '';
    return `${parsed.origin}${parsed.pathname}`.toLowerCase();
  } catch {
    return normalizeUrl(url).toLowerCase().replace(/[?#].*$/, '');
  }
}

function getPlatformLabel(platform: Platform) {
  if (platform === 'zhihu') return '知乎收藏夹';
  if (platform === 'x') return 'X 书签';
  return '小红书收藏';
}

function getCurrentSourceContext(): SourceContext | null {
  const hostname = window.location.hostname.toLowerCase();
  const pathname = window.location.pathname;

  const zhihuMatch = pathname.match(/^\/collection\/(\d+)/);
  if (hostname.includes('zhihu.com') && zhihuMatch) {
    return {
      platform: 'zhihu',
      collectionId: `zhihu:collection:${zhihuMatch[1]}`,
      name: document.title || 'Zhihu Collection',
    };
  }

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname.endsWith('.x.com') || hostname.endsWith('.twitter.com')) && pathname.startsWith('/i/bookmarks')) {
    return {
      platform: 'x',
      collectionId: 'x:bookmarks',
      name: 'X Bookmarks',
    };
  }

  const xhsProfile = pathname.match(/^\/user\/profile\/([a-zA-Z0-9]+)/i);
  if ((hostname.includes('xiaohongshu.com') || hostname.endsWith('.xiaohongshu.com')) && xhsProfile) {
    const userId = xhsProfile[1];
    return {
      platform: 'xiaohongshu',
      collectionId: `xhs:user:${userId}:fav-notes`,
      name: cleanText(document.title.split(/\s*[|\u2013-]\s*/)[0] || '').replace(/小红书$/, '').trim() || '小红书收藏笔记',
    };
  }

  return null;
}

function ensureCrawlOverlay() {
  const existing = document.getElementById('zhihu-distil-crawl-overlay');
  if (existing) return existing;

  const style = document.createElement('style');
  style.id = 'zhihu-distil-crawl-overlay-style';
  style.textContent = `
    #zhihu-distil-crawl-overlay {
      position: fixed;
      top: 88px;
      right: 20px;
      z-index: 2147483647;
      width: 320px;
      max-width: calc(100vw - 32px);
      border-radius: 16px;
      border: 1px solid rgba(23, 114, 246, 0.18);
      background: rgba(9, 9, 11, 0.92);
      color: #f4f4f5;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(12px);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      overflow: hidden;
      pointer-events: none;
    }
    #zhihu-distil-crawl-overlay[data-tone="success"] { border-color: rgba(16, 185, 129, 0.28); }
    #zhihu-distil-crawl-overlay[data-tone="warning"] { border-color: rgba(245, 158, 11, 0.28); }
    #zhihu-distil-crawl-overlay .zd-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px 8px;
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #a1a1aa;
    }
    #zhihu-distil-crawl-overlay .zd-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #22c55e;
      box-shadow: 0 0 0 6px rgba(34, 197, 94, 0.14);
      flex: none;
    }
    #zhihu-distil-crawl-overlay[data-tone="warning"] .zd-dot {
      background: #f59e0b;
      box-shadow: 0 0 0 6px rgba(245, 158, 11, 0.14);
    }
    #zhihu-distil-crawl-overlay[data-tone="success"] .zd-dot {
      background: #10b981;
      box-shadow: 0 0 0 6px rgba(16, 185, 129, 0.14);
    }
    #zhihu-distil-crawl-overlay .zd-body { padding: 0 14px 14px; }
    #zhihu-distil-crawl-overlay .zd-title {
      font-size: 15px;
      font-weight: 600;
      color: #fafafa;
      line-height: 1.4;
    }
    #zhihu-distil-crawl-overlay .zd-detail {
      margin-top: 6px;
      font-size: 13px;
      line-height: 1.5;
      color: #d4d4d8;
    }
  `;

  if (!document.getElementById(style.id)) {
    document.documentElement.appendChild(style);
  }

  const overlay = document.createElement('div');
  overlay.id = 'zhihu-distil-crawl-overlay';
  overlay.innerHTML = `
    <div class="zd-header">
      <span>Bookmark Distil</span>
      <span class="zd-dot" aria-hidden="true"></span>
    </div>
    <div class="zd-body">
      <div class="zd-title"></div>
      <div class="zd-detail"></div>
    </div>
  `;
  document.documentElement.appendChild(overlay);
  return overlay;
}

function updateCrawlOverlay(state: CrawlOverlayState) {
  const overlay = ensureCrawlOverlay();
  overlay.setAttribute('data-tone', state.tone || 'active');
  const title = overlay.querySelector('.zd-title');
  const detail = overlay.querySelector('.zd-detail');
  if (title) title.textContent = state.title;
  if (detail) detail.textContent = state.detail;

  if (crawlOverlayHideTimer !== null) {
    window.clearTimeout(crawlOverlayHideTimer);
    crawlOverlayHideTimer = null;
  }

  if ((state.tone || 'active') !== 'active') {
    crawlOverlayHideTimer = window.setTimeout(() => {
      const current = document.getElementById('zhihu-distil-crawl-overlay');
      current?.remove();
      crawlOverlayHideTimer = null;
    }, 4500);
  }
}

function isZhihuContentUrl(url: string) {
  return /(question\/\d+(\/answer\/\d+)?|zhuanlan\.zhihu\.com\/p\/\d+|\/p\/\d+|zvideo)/i.test(url);
}

function getZhihuCardTextWithoutTitle(card: Element, title: string) {
  const excerptSelectors = ['.RichContent-inner', '.RichText', '.CopyrightRichText-richText', '.ContentItem-excerpt'];
  for (const selector of excerptSelectors) {
    const element = card.querySelector(selector);
    const text = cleanText((element as HTMLElement | null)?.innerText || '');
    if (text) return text;
  }
  const rawText = cleanText((card as HTMLElement).innerText || '');
  if (!rawText) return '';
  if (title && rawText.startsWith(title)) return cleanText(rawText.slice(title.length)).slice(0, 240);
  return rawText.slice(0, 240);
}

function extractZhihuAuthor(card: Element, title: string) {
  const metaAuthor = card.querySelector('meta[itemprop="name"]');
  const metaContent = cleanText(metaAuthor?.getAttribute('content') || '');
  if (metaContent && metaContent !== title) return metaContent;

  const authorLink = card.querySelector('a[href*="/people/"]');
  const authorText = cleanText((authorLink as HTMLElement | null)?.innerText || '');
  if (authorText && authorText !== title) return authorText;

  const authorName = card.querySelector('.AuthorInfo-name');
  const authorNameText = cleanText((authorName as HTMLElement | null)?.innerText || '');
  if (authorNameText && authorNameText !== title) return authorNameText;

  return 'Unknown';
}

function detectZhihuMedia(card: Element) {
  const hasVideo = Boolean(
    card.querySelector('video, .VideoCard, .VideoCard-video, .ZVideo-player, iframe[src*="video"], embed[src*="video"]'),
  );
  const body = card.querySelector('.RichContent-inner, CopyrightRichText-richText, .RichText');
  const hasImage = Boolean(body?.querySelector('img'));
  return { hasImage: hasVideo || hasImage, hasVideo };
}

function extractZhihuItems(): BookmarkItem[] {
  const cards = Array.from(document.querySelectorAll('.ContentItem, article, .List-item'));
  const items: BookmarkItem[] = [];
  const seen = new Set<string>();

  for (const card of cards) {
    const anchors = Array.from(card.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const targetAnchor = anchors.find((anchor) => {
      const url = normalizeUrl(anchor.getAttribute('href') || '');
      const text = cleanText(anchor.innerText || anchor.textContent || '');
      return isZhihuContentUrl(url) && Boolean(text);
    });
    if (!targetAnchor) continue;

    const url = normalizeUrl(targetAnchor.getAttribute('href') || '');
    if (!url || seen.has(url)) continue;

    const title = cleanText(
      (card.querySelector('h2.ContentItem-title') as HTMLElement | null)?.innerText ||
      (card.querySelector('h2') as HTMLElement | null)?.innerText ||
      targetAnchor.innerText ||
      targetAnchor.textContent ||
      ''
    );
    if (!title) continue;

    seen.add(url);
    const { hasImage, hasVideo } = detectZhihuMedia(card);
    items.push({
      title,
      url,
      excerpt: getZhihuCardTextWithoutTitle(card, title),
      author: extractZhihuAuthor(card, title),
      addedAt: Date.now(),
      containsImage: hasImage,
      containsVideo: hasVideo,
    });
  }

  return items;
}

function extractXAuthor(article: Element) {
  const userName = cleanText((article.querySelector('[data-testid="User-Name"]') as HTMLElement | null)?.innerText || '');
  const match = userName.match(/^(.*?)\s*@/);
  if (match?.[1]) return cleanText(match[1]);
  return userName.split('·')[0].trim() || 'Unknown';
}

function detectXMedia(article: Element) {
  const hasImage = Boolean(
    article.querySelector('[data-testid="tweetPhoto"], [data-testid="tweetPhoto"] img, [data-testid="media"] img')
  );
  const hasVideo = Boolean(
    article.querySelector('[data-testid="videoPlayer"], video, [aria-label*="GIF"], [aria-label*="Video"]')
  );

  return { hasImage, hasVideo };
}

function extractXItems(): BookmarkItem[] {
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const items: BookmarkItem[] = [];
  const seen = new Set<string>();

  for (const article of articles) {
    const anchors = Array.from(article.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const statusAnchor = anchors.find((anchor) => /^\/[^/]+\/status\/\d+$/.test(anchor.getAttribute('href') || ''));
    if (!statusAnchor) continue;

    const url = normalizeUrl(statusAnchor.getAttribute('href') || '');
    if (!url || seen.has(url)) continue;

    const tweetText = cleanText((article.querySelector('[data-testid="tweetText"]') as HTMLElement | null)?.innerText || '');
    const author = extractXAuthor(article);
    const { hasImage, hasVideo } = detectXMedia(article);
    const titleBase = tweetText || cleanText((statusAnchor as HTMLElement).innerText || '') || 'Bookmarked Post';
    const title = `${author}: ${titleBase.slice(0, 60)}${titleBase.length > 60 ? '...' : ''}`;

    seen.add(url);
    items.push({
      title,
      url,
      excerpt: tweetText || '暂无正文预览',
      author,
      addedAt: Date.now(),
      containsImage: hasImage,
      containsVideo: hasVideo,
    });
  }

  return items;
}

/**
 * 个人主页里「我发布的」与「收藏」各自有 feeds 容器。
 * `#userPostedFeeds` 往往指向**发布**流（常为空的 empty-container），
 * 收藏笔记在另一个 `class="feeds-container"`（常为无 id）里。
 * 必须选用**实际含有 `.note-item`** 的容器，否则会一直抓到 0 条。
 */
function findXhsFeedRoot(): HTMLElement {
  const cardSel = 'section.note-item, .note-item:not(.query-note-item)';
  const candidates = Array.from(document.querySelectorAll('#exploreFeeds, #userPostedFeeds, .feeds-container')) as HTMLElement[];
  const withNotes = candidates.filter((el) => el.querySelector(cardSel));

  if (withNotes.length <= 1) {
    const pick = withNotes[0];
    if (pick) return pick;
    const firstCard = document.querySelector(cardSel);
    const fromCard = firstCard?.closest('.feeds-container, [class*="feeds-container"], main') as HTMLElement | null;
    return fromCard || document.body;
  }

  /** 多列（笔记/收藏/点赞）各自有 feeds-container：优先当前视口内可见、且真正处于活动态的那一列 */
  const ranked = withNotes.map((el) => {
    const panel = el.closest('.tab-content-item') as HTMLElement | null;
    const panelStyle = panel ? window.getComputedStyle(panel) : null;
    const style = panel?.getAttribute('style') ?? '';
    const collapsed =
      !panel ||
      panel.clientHeight < 4 ||
      panelStyle?.display === 'none' ||
      panelStyle?.visibility === 'hidden' ||
      Number.parseFloat(panelStyle?.opacity || '1') < 0.02 ||
      /\bheight:\s*0(?:px)?\b/i.test(style) ||
      /\boverflow:\s*hidden\b/i.test(style);
    const n = el.querySelectorAll(cardSel).length;
    const visibleArea = getElementViewportVisibleArea(panel ?? el);
    const activeTab = Boolean(panel && panel.classList.contains('active'));
    const scrollablePanel = Boolean(
      panel &&
        panelStyle &&
        /^(auto|scroll|overlay)$/i.test(panelStyle.overflowY || '') &&
        visibleArea > 0,
    );
    const nonStatic = !el.classList.contains('static-layout');
    return { el, collapsed, n, visibleArea, activeTab, scrollablePanel, nonStatic };
  });
  ranked.sort(
    (a, b) =>
      Number(a.collapsed) - Number(b.collapsed) ||
      Number(b.activeTab) - Number(a.activeTab) ||
      Number(b.scrollablePanel) - Number(a.scrollablePanel) ||
      b.visibleArea - a.visibleArea ||
      Number(b.nonStatic) - Number(a.nonStatic) ||
      b.n - a.n,
  );
  return ranked[0].el;
}

/** 24-char hex note ids; allow 20–32 for forward-compat */
function parseXhsNoteIdFromPathname(pathname: string): string | null {
  const p = pathname.replace(/\/+$/, '');
  const explore = p.match(/^\/explore\/([0-9a-f]{20,32})(?:\/|$)/i);
  if (explore) return explore[1].toLowerCase();

  const profileNote = p.match(/^\/user\/profile\/[a-zA-Z0-9]+\/([0-9a-f]{20,32})(?:\/|$)/i);
  if (profileNote) return profileNote[1].toLowerCase();

  const disc = p.match(/^\/discovery\/item\/([0-9a-f]{20,32})/i);
  if (disc) return disc[1].toLowerCase();

  const sr = p.match(/^\/search_result\/([0-9a-f]{20,32})/i);
  if (sr) return sr[1].toLowerCase();

  return null;
}

function canonicalXhsNoteUrl(noteId: string) {
  return `${window.location.origin}/explore/${noteId}`;
}

function guessXhsAuthorFromTitle() {
  return cleanText(document.title.split(/\s*[|\u2013-]\s*/)[0] || '').replace(/小红书$/, '').trim() || '小红书';
}

function pathIsXhsProfileOnly(pathname: string) {
  return /^\/user\/profile\/[a-zA-Z0-9]+\/?$/i.test(pathname.replace(/\/+$/, ''));
}

/**
 * 收藏夹流里每条笔记是 `section.note-item`；封面真实链接多为
 * `/user/profile/{uid}/{noteId}?xsec_token=...&xsec_source=pc_collect`，另有隐藏的 `/explore/{noteId}`。
 * 统一归一成 `/explore/{noteId}` 作为存储主键。
 */
function extractFromXhsNoteCard(section: Element): BookmarkItem | null {
  const anchors = Array.from(section.querySelectorAll('a[href]')) as HTMLAnchorElement[];
  let noteId: string | null = null;

  for (const a of anchors) {
    let parsed: URL;
    try {
      parsed = new URL(normalizeUrl(a.getAttribute('href') || ''));
    } catch {
      continue;
    }
    if (!parsed.hostname.toLowerCase().includes('xiaohongshu')) continue;
    if (pathIsXhsProfileOnly(parsed.pathname)) continue;

    const id = parseXhsNoteIdFromPathname(parsed.pathname);
    if (id) {
      noteId = id;
      break;
    }
  }

  if (!noteId) return null;

  const titleSpan =
    (section.querySelector('.footer a.title span, a.title span') as HTMLElement | null) ||
    (section.querySelector('a.title span') as HTMLElement | null);
  const titleAnchor =
    (section.querySelector('.footer a.title[href], a.title[href]') as HTMLElement | null) ||
    (section.querySelector('a.title[href]') as HTMLElement | null);
  let title = cleanText(titleSpan?.innerText || titleAnchor?.innerText || '');
  if (!title) {
    const loose = section.querySelector('.footer [class*="title"], [class*="note-title"]') as HTMLElement | null;
    title = cleanText(loose?.innerText || '');
  }
  if (!title) {
    const img = section.querySelector('img[alt]:not([alt=""])') as HTMLImageElement | null;
    title = cleanText(img?.getAttribute('alt') || '') || '小红书笔记';
  }

  const authorEl = section.querySelector('.author-wrapper a.author, a.author') as HTMLElement | null;
  const author = cleanText(authorEl?.innerText || '') || guessXhsAuthorFromTitle();

  const hasVideo = Boolean(section.querySelector('video, .play-icon, span.play-icon'));
  const hasImg = Boolean(section.querySelector('img[src*="xhscdn"], img[data-xhs-img], img'));

  const url = canonicalXhsNoteUrl(noteId);
  const excerpt = title.slice(0, 420);

  return {
    title: title.slice(0, 200),
    url,
    excerpt,
    author,
    addedAt: Date.now(),
    containsImage: hasImg || hasVideo,
    containsVideo: hasVideo,
  };
}

function extractXhsItems(): BookmarkItem[] {
  const items: BookmarkItem[] = [];
  const seen = new Set<string>();
  const root = findXhsFeedRoot();

  const cards = Array.from(
    root.querySelectorAll('section.note-item, .note-item:not(.query-note-item)'),
  ) as HTMLElement[];
  for (const card of cards) {
    const entry = extractFromXhsNoteCard(card);
    if (!entry) continue;
    const key = getBookmarkKey(entry.url);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(entry);
  }

  if (items.length > 0) return items;

  const authorFallback = guessXhsAuthorFromTitle();
  const anchors = Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[];

  for (const anchor of anchors) {
    let parsed: URL;
    try {
      parsed = new URL(normalizeUrl(anchor.getAttribute('href') || ''));
    } catch {
      continue;
    }
    if (!parsed.hostname.toLowerCase().includes('xiaohongshu')) continue;
    if (pathIsXhsProfileOnly(parsed.pathname)) continue;

    const noteId = parseXhsNoteIdFromPathname(parsed.pathname);
    if (!noteId) continue;

    const url = canonicalXhsNoteUrl(noteId);
    const key = getBookmarkKey(url);
    if (seen.has(key)) continue;

    const container = anchor.closest('section.note-item, .note-item, section[class], article') || anchor.parentElement;
    let title = cleanText((anchor.innerText || anchor.getAttribute('aria-label') || anchor.getAttribute('title') || '').trim());
    const pickImg = container?.querySelector('img[alt]:not([alt=""])');
    const alt = cleanText(((pickImg as HTMLImageElement | null)?.getAttribute('alt') || '').trim());
    if (title.length < 2) title = alt || '小红书笔记';

    const body = (container || anchor) as HTMLElement;
    const excerptRaw = alt || cleanText(body.innerText || '');
    let excerpt = excerptRaw.slice(0, 420);
    if (cleanText(excerpt) === cleanText(title)) excerpt = '';

    const hasVideo = Boolean(body.querySelector('video, .play-icon'));
    const hasImg = Boolean(body.querySelector('img'));

    seen.add(key);
    items.push({
      title: title.slice(0, 200),
      url,
      excerpt: excerpt || alt || '',
      author: authorFallback,
      addedAt: Date.now(),
      containsImage: hasImg || hasVideo,
      containsVideo: hasVideo,
    });
  }

  return items;
}

function extractItemsFromPage(context: SourceContext): BookmarkItem[] {
  if (context.platform === 'zhihu') return extractZhihuItems();
  if (context.platform === 'xiaohongshu') return extractXhsItems();
  return extractXItems();
}

function mergeItems(existing: BookmarkItem[], incoming: BookmarkItem[]) {
  const map = new Map(existing.map((item) => [getBookmarkKey(item.url), item]));
  for (const item of incoming) {
    const key = getBookmarkKey(item.url);
    const prev = map.get(key);
    map.set(key, {
      ...prev,
      ...item,
      excerpt: item.excerpt || prev?.excerpt || '',
      author: item.author || prev?.author || 'Unknown',
      addedAt: prev?.addedAt || item.addedAt,
      containsImage: Boolean(item.containsImage ?? prev?.containsImage),
      containsVideo: Boolean(item.containsVideo ?? prev?.containsVideo),
    });
  }
  return Array.from(map.values());
}

function collectNewItems(items: BookmarkItem[], knownKeys: Set<string>) {
  const freshItems: BookmarkItem[] = [];

  for (const item of items) {
    const key = getBookmarkKey(item.url);
    if (knownKeys.has(key)) continue;
    knownKeys.add(key);
    freshItems.push(item);
  }

  return freshItems;
}

function getPageSignature(context: SourceContext) {
  const items = extractItemsFromPage(context);
  /** 仅小红书收藏流：虚拟列表导致可见条数几乎不变，需用视口内全部条目的稳定键集合做签名；X/知乎仍用原先前 8 条 URL，避免影响已正常工作的平台 */
  if (context.platform === 'xiaohongshu') {
    if (items.length === 0) return '';
    const keys = items.map((item) => getBookmarkKey(item.url)).sort();
    return `${keys.length}:${keys.join('\u0001')}`;
  }
  return items
    .slice(0, 8)
    .map((item) => item.url)
    .join('|');
}

async function scrapeCurrentPage(context: SourceContext): Promise<BookmarkItem[]> {
  await waitForScrapeableContent(context);
  return extractItemsFromPage(context);
}

function getZhihuNextPageControl(): NextPageControl | null {
  const nextButton = document.querySelector('.PaginationButton-next');
  if (!nextButton) return null;
  if (nextButton instanceof HTMLButtonElement) return nextButton.disabled ? null : { kind: 'button', element: nextButton };
  if (nextButton instanceof HTMLAnchorElement) return nextButton.href ? { kind: 'anchor', element: nextButton } : null;
  return null;
}


async function finishCrawling(context: SourceContext, newItems: BookmarkItem[]) {
  const data = await chrome.storage.local.get(['collections', 'trashIndex']);
  const collections = (data.collections || {}) as Record<string, Collection>;
  const trashIndex = (data.trashIndex || {}) as Record<string, TrashRecord>;
  const existingItems = collections[context.collectionId]?.items || [];
  const mergedItems = mergeItems(existingItems, newItems);
  const filteredItems = mergedItems.filter((item) => !trashIndex[getBookmarkKey(item.url)]);
  const addedCount = filteredItems.length - existingItems.length;

  updateCrawlOverlay({
    title: '抓取完成',
    detail: `已完成${getPlatformLabel(context.platform)}增量同步，本次新增 ${Math.max(0, addedCount)} 条，当前总计 ${filteredItems.length} 条内容。`,
    tone: 'success',
  });
  await chrome.storage.local.remove(['crawlState', 'pendingImport']);

  collections[context.collectionId] = {
    id: context.collectionId,
    name: context.name,
    items: filteredItems,
    lastUpdated: Date.now(),
  };
  await chrome.storage.local.set({ collections });

  safeRuntimeSendMessage({ type: 'CRAWL_FINISHED', collectionId: context.collectionId });
}

async function crawlZhihu(context: SourceContext, page: number, newItems: BookmarkItem[], knownKeys: Set<string>, hasExistingItems: boolean) {
  let currentPage = page;
  let mergedItems = newItems;

  while (true) {
    updateCrawlOverlay({
      title: `正在抓取${getPlatformLabel(context.platform)}`,
      detail: `当前第 ${currentPage} 页，本次已新增 ${mergedItems.length} 条内容。请不要关闭这个标签页，扩展会自动翻页。`,
      tone: 'active',
    });

    const items = await scrapeCurrentPage(context);
    const freshItems = collectNewItems(items, knownKeys);
    mergedItems = mergeItems(mergedItems, freshItems);

    if (hasExistingItems && items.length > 0 && freshItems.length === 0) {
      updateCrawlOverlay({
        title: '检测到已抓过的页面，提前停止',
        detail: `这一页没有发现新的内容，本次已新增 ${mergedItems.length} 条，已停止继续翻页。`,
        tone: 'success',
      });
      await finishCrawling(context, mergedItems);
      return;
    }

    const nextControl = getZhihuNextPageControl();
    if (!nextControl) {
      await finishCrawling(context, mergedItems);
      return;
    }

    await chrome.storage.local.set({
      crawlState: {
        collectionId: context.collectionId,
        items: mergedItems,
        page: currentPage + 1,
        isCrawling: true,
      },
    });

    if (nextControl.kind === 'anchor') {
      updateCrawlOverlay({
        title: '正在翻到下一页',
        detail: `本次已新增 ${mergedItems.length} 条内容，马上进入第 ${currentPage + 1} 页继续抓取。`,
        tone: 'active',
      });
      window.location.href = nextControl.element.href;
      return;
    }

    const previousSignature = getPageSignature(context);
    const previousItemCount = items.length;
    updateCrawlOverlay({
      title: '正在翻页',
      detail: `本次已新增 ${mergedItems.length} 条内容，正在点击“下一页”继续抓取。`,
      tone: 'active',
    });
    nextControl.element.click();
    const changed = await waitForFeedUpdate(context, previousSignature, previousItemCount, { scrolled: false });
    if (!changed) {
      updateCrawlOverlay({
        title: '翻页未成功，已先保存当前结果',
        detail: `当前本次已新增 ${mergedItems.length} 条内容。你可以回到扩展页检查结果，或刷新后重试。`,
        tone: 'warning',
      });
      await finishCrawling(context, mergedItems);
      return;
    }
    currentPage += 1;
  }
}

async function crawlXBookmarks(context: SourceContext, page: number, newItems: BookmarkItem[], knownKeys: Set<string>, hasExistingItems: boolean) {
  let currentPage = page;
  let mergedItems = newItems;
  let stagnantRounds = 0;
  let noNewRounds = 0;
  const maxStagnantRounds = context.platform === 'xiaohongshu' ? 15 : 3;
  const maxNoNewRoundsBeforeEarlyStop = context.platform === 'xiaohongshu' ? 8 : 2;
  const minStagnantRoundsBeforeEarlyStop = context.platform === 'xiaohongshu' ? 3 : 1;

  while (stagnantRounds < maxStagnantRounds) {
    updateCrawlOverlay({
      title: `正在抓取${getPlatformLabel(context.platform)}`,
      detail: `当前第 ${currentPage} 轮滚动，本次已新增 ${mergedItems.length} 条内容。请保持页面开启，扩展会自动下拉加载更多。`,
      tone: 'active',
    });

    const items = await scrapeCurrentPage(context);
    const freshItems = collectNewItems(items, knownKeys);
    const beforeCount = mergedItems.length;
    mergedItems = mergeItems(mergedItems, freshItems);

    await chrome.storage.local.set({
      crawlState: {
        collectionId: context.collectionId,
        items: mergedItems,
        page: currentPage + 1,
        isCrawling: true,
      },
    });

    const previousSignature = getPageSignature(context);
    const previousItemCount = items.length;
    const scrollMotionTarget = scrollInfiniteFeedToEnd(context);
    const changed = await waitForFeedUpdate(context, previousSignature, previousItemCount, {
      scrolled: true,
      scrollMotionTarget,
    });

    if (!changed || mergedItems.length === beforeCount) {
      stagnantRounds += 1;
    } else {
      stagnantRounds = 0;
    }

    if (freshItems.length === 0) {
      noNewRounds += 1;
    } else {
      noNewRounds = 0;
    }

    /**
     * X / Twitter 的书签流通常按时间线稳定追加，连续两轮没新增基本可判定触底。
     * 但小红书收藏是虚拟瀑布流，前几轮常先重复出现已同步过的可见项，过早停止会只抓两三轮。
     */
    if (hasExistingItems && noNewRounds >= maxNoNewRoundsBeforeEarlyStop && stagnantRounds >= minStagnantRoundsBeforeEarlyStop) {
      updateCrawlOverlay({
        title: '检测到已同步过的内容，提前停止',
        detail: `连续多轮没有发现新书签，且页面已趋于稳定，本次已新增 ${mergedItems.length} 条，已停止继续下拉。`,
        tone: 'success',
      });
      await finishCrawling(context, mergedItems);
      return;
    }

    currentPage += 1;
  }

  await finishCrawling(context, mergedItems);
}

async function startCrawling(context: SourceContext) {
  const state = await chrome.storage.local.get(['crawlState', 'collections']);
  const crawlState = state.crawlState as CrawlState | undefined;
  const collections = (state.collections || {}) as Record<string, Collection>;
  const existingItems = collections[context.collectionId]?.items || [];
  const hasExistingItems = existingItems.length > 0;
  const baselineKnownKeys = new Set(existingItems.map((item) => getBookmarkKey(item.url)));

  let page = 1;
  let allItems: BookmarkItem[] = [];
  if (crawlState && crawlState.collectionId === context.collectionId) {
    allItems = crawlState.items || [];
    page = crawlState.page;
  }

  for (const item of allItems) {
    baselineKnownKeys.add(getBookmarkKey(item.url));
  }

  if (context.platform === 'zhihu') {
    await crawlZhihu(context, page, allItems, baselineKnownKeys, hasExistingItems);
    return;
  }

  await crawlXBookmarks(context, page, allItems, baselineKnownKeys, hasExistingItems);
}

async function autoStartIfNeeded() {
  const context = getCurrentSourceContext();
  if (!context) return;

  const state = await chrome.storage.local.get(['crawlState', 'pendingImport']);
  const crawlState = state.crawlState as CrawlState | undefined;
  const pendingImport = state.pendingImport as PendingImport | undefined;

  if (crawlState && crawlState.isCrawling && crawlState.collectionId === context.collectionId) {
    updateCrawlOverlay({
      title: '已恢复抓取任务',
      detail: `检测到这个来源之前抓到第 ${crawlState.page} 轮，正在继续执行。`,
      tone: 'active',
    });
    await startCrawling(context);
    return;
  }

  if (pendingImport && pendingImport.collectionId === context.collectionId) {
    updateCrawlOverlay({
      title: '扩展已接管当前页面',
      detail: `这是你刚刚发起抓取的${getPlatformLabel(context.platform)}，扩展正在读取页面内容并准备继续抓取。`,
      tone: 'active',
    });
    await startCrawling(context);
  }
}

window.addEventListener('load', () => {
  void autoStartIfNeeded();
});

type ContentRequest = { type: 'START_CRAWL' };

function isContentRequest(value: unknown): value is ContentRequest {
  if (!value || typeof value !== 'object') return false;
  return 'type' in value;
}

chrome.runtime.onMessage.addListener((request: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
  if (!isContentRequest(request)) return;
  if (request.type === 'START_CRAWL') {
    const context = getCurrentSourceContext();
    if (context) {
      void startCrawling(context);
      sendResponse({ status: 'started', collectionId: context.collectionId });
    } else {
      sendResponse({ status: 'error', message: '当前页面不是受支持的知乎收藏夹、小红书收藏笔记或 X 书签页面。' });
    }
  }
});
