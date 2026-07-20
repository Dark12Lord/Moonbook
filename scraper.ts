// ─── scraper.ts ───────────────────────────────────────────────
// يتصل بـ moonbook-proxy على HuggingFace Spaces
// الـ Proxy هو اللي يفتح المواقع بمتصفح حقيقي

import { logError } from './logger';

const PROXY_URL = (process.env.PROXY_URL || '').replace(/\/$/, '');

export interface MangaSearchResult {
  title: string;
  slug: string;
  cover: string;
  url: string;
}

export interface MangaDetails {
  title: string;
  slug: string;
  cover: string;
  description: string;
  status: string;
  genres: string[];
  url: string;
  chapters: ChapterEntry[];
}

export interface ChapterEntry {
  number: string;
  label: string;
  url: string;
}

export interface ChapterPages {
  chapterLabel: string;
  images: string[];
}

async function proxyGet<T>(endpoint: string): Promise<T> {
  if (!PROXY_URL) throw new Error('PROXY_URL غير محدد في متغيرات البيئة');

  const url = `${PROXY_URL}${endpoint}`;
  console.log(`[scraper] → ${url}`);

  const res = await fetch(url, {
    signal: AbortSignal.timeout(60_000), // نعطيه وقت كافي لـ Playwright
  });

  console.log(`[scraper] ← ${res.status} ${endpoint}`);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Proxy error ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

export async function searchManga(query: string): Promise<MangaSearchResult[]> {
  try {
    const data = await proxyGet<{ results: MangaSearchResult[] }>(
      `/search?q=${encodeURIComponent(query)}`
    );
    return data.results || [];
  } catch (err: any) {
    await logError({ context: 'searchManga', message: err.message, stack: err.stack });
    throw new Error(`فشل البحث: ${err.message}`);
  }
}

export async function getMangaDetails(slug: string): Promise<MangaDetails> {
  try {
    return await proxyGet<MangaDetails>(`/manga/${encodeURIComponent(slug)}`);
  } catch (err: any) {
    await logError({ context: 'getMangaDetails', message: err.message, stack: err.stack });
    throw new Error(`فشل جلب تفاصيل المانهوا: ${err.message}`);
  }
}

export async function getChapterPages(chapterUrl: string): Promise<ChapterPages> {
  try {
    const data = await proxyGet<{ label: string; images: string[] }>(
      `/chapter?url=${encodeURIComponent(chapterUrl)}`
    );
    return { chapterLabel: data.label, images: data.images };
  } catch (err: any) {
    await logError({ context: 'getChapterPages', message: err.message, stack: err.stack });
    throw new Error(`فشل جلب صور الفصل: ${err.message}`);
  }
}
