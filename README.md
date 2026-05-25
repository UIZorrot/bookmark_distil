# Bookmark Distil

Chrome extension that pulls your **Zhihu/X/xiaohongshu bookmarks** into one workspace: deduplicated entries, summaries, tagging, trash for low-confidence items, Markdown archives on demand, and a **bring-your-own-key (BYOK)** chat over your indexed bookmarks.

---

## Requirements

- **Node.js** 20+ recommended  
- npm 10+

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

Use the `@crxjs/vite-plugin` dev flow as documented in the [crxjs Vite Plugin guide](https://crxjs.dev/vite-plugin/).

For local member/backend integration, run the API separately:

```bash
npm run backend:dev
```

The extension reads `VITE_MEMBER_API_BASE` from the root `.env` at build/dev time. The default is `http://127.0.0.1:8789/api/v1`, so local backend testing works before deploying `tool.bookmark.txzy.net`.

## Production build & load unpacked

```bash
npm run build
```

Then in Chrome → **Extensions** → enable **Developer mode** → **Load unpacked** → select the **`dist`** directory (generated after build).

---

## Backend (membership / hosted AI)

FastAPI — Postgres + Resend + Stripe + DeepSeek/OpenRouter — for **`tool.bookmark.txzy.net`** is under **`backend/`**. See **`backend/README.md`** and **`backend/.env.example`**.

---

## Typical usage

1. Open the extension options / action page (bookmark workspace).
2. Under **Overview**, paste a supported URL:
   - Zhihu collection, e.g. `https://www.zhihu.com/collection/782964767`
   - X bookmarks: `https://x.com/i/bookmarks`
3. Click **Start crawling**. The extension opens the page and the content script paginates imports into local storage.
4. Optional: **Analyze remaining** (requires API key in Settings) or wait for automatic analysis after crawl.
5. Configure **API Key**, **endpoint** (e.g. OpenAI-compatible `…/chat/completions`), and **model** under **Settings** for LLM features.
6. Use **Chat** to ask questions grounded in your saved summaries and metadata.

Data is stored in **`chrome.storage.local`** on your device unless you later enable cloud sync (see product roadmap in `dev.md`).

---

## Permissions (summary)

Declared in `manifest.json`:

| Permission / host access | Purpose |
|--------------------------|---------|
| `storage` | Save collections, settings, chat threads, job status |
| `tabs` | Open Zhihu/X pages for crawling |
| `activeTab`, `scripting` | Injection where needed alongside manifest content scripts |
| `downloads` | Save Markdown archives produced by link validation flow |
| `host_permissions`: `https://*/*` | **(1)** User-configured **HTTPS-only** BYOK LLM calls from the background worker; **(2)** HTTPS `fetch` when **re-validating bookmark URLs** from the extension. Zhihu/X collection pages themselves run inside normal tabs and content scripts. |

**HTTP (`http://…`) bookmarks** are not fetched by the service worker link checker in this permission profile; those entries are marked as **skipped** for remote validation rather than implying network access Chrome would block anyway.

See **`PRIVACY.md`** for a privacy-oriented description aligned with disclosure text.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server / CRX dev |
| `npm run build` | Type-check + extension bundle to `dist/` |
| `npm run lint` | ESLint |
| `npm run test:e2e` | Build + Playwright smoke |

---

## More

- **`PRIVACY.md`** — data handling for users and Chrome Web Store disclosure.
- **`STORE_LISTING.md`** — bilingual draft listing short/long descriptions.
- **`dev.md`** — product and release checklist.
