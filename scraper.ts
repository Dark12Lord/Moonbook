// ─── scraper.ts ───────────────────────────────────────────────
// يستخدم OriginManga Public API — مجاني، بدون مفتاح، بدون Playwright
// https://originmanga.com/api/public

import { logError } from './logger';

const API = 'https://originmanga.com/api/public';

export interface MangaSearchResult {
  title: string;
  slug: string;  // نستخدم الـ ID بدل slug هنا
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
  pages?: string[];  // OriginManga يعطينا الصور مباشرة
}

export interface ChapterPages {
  chapterLabel: string;
  images: string[];
}

async function apiGet<T>(endpoint: string): Promise<T> {
  const url = `${API}${endpoint}`;
  console.log(`[scraper] → ${url}`);

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });

  console.log(`[scraper] ← ${res.status} ${endpoint}`);
  if (!res.ok) throw new Error(`API error ${res.status}: ${endpoint}`);
  return res.json();
}

// ─── بحث ──────────────────────────────────────────────────────
async function rawSearch(query: string): Promise<any[]> {
  const data = await apiGet<{ manga: any[] }>(
    `/manga?query=${encodeURIComponent(query)}&limit=10`
  );
  return data.manga || [];
}

// يشيل علامات الترقيم ويبسّط النص عشان يزيد فرصة المطابقة عند الـ API
function simplifyQuery(query: string): string {
  return query
    .replace(/[,.!?:;"'’“”()\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function searchManga(query: string): Promise<MangaSearchResult[]> {
  try {
    let manga = await rawSearch(query);

    // محاولة 2: نفس الاستعلام لكن بدون علامات الترقيم
    if (!manga.length) {
      const simplified = simplifyQuery(query);
      if (simplified && simplified !== query) {
        manga = await rawSearch(simplified);
      }
    }

    // محاولة 3: أول كلمتين بس من العنوان (مفيد للعناوين الطويلة)
    if (!manga.length) {
      const words = simplifyQuery(query).split(' ').filter(Boolean);
      if (words.length > 2) {
        const shortQuery = words.slice(0, 2).join(' ');
        manga = await rawSearch(shortQuery);
      }
    }

    return manga.map((m: any) => ({
      title: m.title || m.id,
      slug: m.id,
      cover: m.coverUrl || '',
      url: `https://originmanga.com/manga/${m.id}`,
    }));
  } catch (err: any) {
    await logError({ context: 'searchManga', message: err.message, stack: err.stack });
    throw new Error(`فشل البحث: ${err.message}`);
  }
}

// ─── تفاصيل المانهوا + الفصول ─────────────────────────────────
export async function getMangaDetails(id: string): Promise<MangaDetails> {
  try {
    // جلب التفاصيل والفصول بالتوازي
    const [detailData, chapData] = await Promise.all([
      apiGet<{ manga: any }>(`/manga/${id}`),
      apiGet<{ manga: any; chapters: any[] }>(`/manga/${id}/chapters?order=asc`),
    ]);

    const m = detailData.manga;
    const chapters: ChapterEntry[] = (chapData.chapters || []).map((ch: any) => ({
      number: String(ch.chapterNumber),
      label: ch.title ? `الفصل ${ch.chapterNumber}: ${ch.title}` : `الفصل ${ch.chapterNumber}`,
      // نخزن mangaId|chapterNumber عشان getChapterPages يعرف يجيب الصور
      url: `${id}|${ch.chapterNumber}`,
      pages: ch.pages || [],
    }));

    return {
      title: m.title || id,
      slug: id,
      cover: m.coverUrl || '',
      description: m.description || '',
      status: m.status === 'COMPLETED' ? 'مكتملة' : m.status === 'ONGOING' ? 'مستمرة' : m.status || 'غير معروف',
      genres: m.genres || [],
      url: `https://originmanga.com/manga/${id}`,
      chapters,
    };
  } catch (err: any) {
    await logError({ context: 'getMangaDetails', message: err.message, stack: err.stack });
    throw new Error(`فشل جلب المانهوا: ${err.message}`);
  }
}

// ─── صور الفصل ────────────────────────────────────────────────
// في OriginManga، الـ pages تأتي مع /manga/{mangaId}/chapters
// نحفظ chapter ID في url وnجيب صور الفصل من نفس endpoint
export async function getChapterPages(chapterUrl: string): Promise<ChapterPages> {
  try {
    // chapterUrl هنا بصيغة "{mangaId}|{chapterNumber}|{chapterTitle}"
    // أو مجرد الـ pages مخزّنة مسبقاً
    const parts = chapterUrl.split('|');
    const mangaId = parts[0];
    const chapterNum = parts[1];

    const data = await apiGet<{ manga: any; chapters: any[] }>(
      `/manga/${mangaId}/chapters?order=asc`
    );

    const ch = data.chapters?.find(
      (c: any) => String(c.chapterNumber) === String(chapterNum)
    );

    if (!ch?.pages?.length) throw new Error('لم يتم العثور على صور الفصل');

    return {
      chapterLabel: ch.title ? `الفصل ${ch.chapterNumber}: ${ch.title}` : `الفصل ${ch.chapterNumber}`,
      images: ch.pages,
    };
  } catch (err: any) {
    await logError({ context: 'getChapterPages', message: err.message, stack: err.stack });
    throw new Error(`فشل جلب صور الفصل: ${err.message}`);
  }
}
