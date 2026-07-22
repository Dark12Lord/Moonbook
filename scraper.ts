// ─── scraper.ts ───────────────────────────────────────────────
// يستخدم olympustaff.com (Team-X) — مانجا عربية مترجمة
// بدون API — يسحب HTML مباشرة بدون كابتشا

import { logError } from './logger';

const BASE = 'https://olympustaff.com';

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
  pages?: string[];
}

export interface ChapterPages {
  chapterLabel: string;
  images: string[];
}

// ─── أداة سحب HTML ────────────────────────────────────────────
async function fetchHtml(url: string): Promise<string> {
  console.log(`[scraper] → ${url}`);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ar,en;q=0.9',
    },
    signal: AbortSignal.timeout(20_000),
  });
  console.log(`[scraper] ← ${res.status} ${url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

// ─── مساعد: استخراج نص بين نمطين ─────────────────────────────
function extractBetween(html: string, start: string, end: string): string {
  const s = html.indexOf(start);
  if (s === -1) return '';
  const e = html.indexOf(end, s + start.length);
  if (e === -1) return '';
  return html.slice(s + start.length, e).trim();
}

// ─── استخراج جميع التكرارات بين نمطين ───────────────────────
function extractAll(html: string, start: string, end: string): string[] {
  const results: string[] = [];
  let pos = 0;
  while (true) {
    const s = html.indexOf(start, pos);
    if (s === -1) break;
    const e = html.indexOf(end, s + start.length);
    if (e === -1) break;
    results.push(html.slice(s + start.length, e).trim());
    pos = e + end.length;
  }
  return results;
}

// ─── تنظيف HTML من الوسوم ─────────────────────────────────────
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ─── بحث ──────────────────────────────────────────────────────
export async function searchManga(query: string): Promise<MangaSearchResult[]> {
  try {
    const url = `${BASE}/series?search=${encodeURIComponent(query)}`;
    const html = await fetchHtml(url);

    const results: MangaSearchResult[] = [];

    // كل بطاقة مانهوا في صفحة البحث
    // البنية: <a href="/series/SLUG"> ... <img src="..."> ... عنوان ...
    const cards = extractAll(html, '<div class="bs">', '</div>');

    for (const card of cards) {
      // استخراج الـ slug من الرابط
      const hrefMatch = card.match(/href="\/series\/([^"]+)"/);
      if (!hrefMatch) continue;
      const slug = hrefMatch[1];

      // استخراج الغلاف
      const coverMatch = card.match(/src="([^"]+\.(jpg|png|webp|gif))"/i);
      const cover = coverMatch ? coverMatch[1] : '';

      // استخراج العنوان
      const titleMatch = card.match(/class="tt"[^>]*>([^<]+)</);
      const title = titleMatch ? titleMatch[1].trim() : slug;

      if (slug && !slug.includes('?')) {
        results.push({
          title,
          slug,
          cover,
          url: `${BASE}/series/${slug}`,
        });
      }
    }

    // لو ما لقينا بالـ div.bs، نجرب طريقة ثانية (قائمة مانهوا)
    if (!results.length) {
      const links = extractAll(html, 'href="/series/', '"');
      const seen = new Set<string>();
      for (const slug of links) {
        if (slug.includes('/') || slug.includes('?') || seen.has(slug)) continue;
        seen.add(slug);
        results.push({
          title: slug.replace(/-/g, ' '),
          slug,
          cover: '',
          url: `${BASE}/series/${slug}`,
        });
        if (results.length >= 10) break;
      }
    }

    console.log(`[scraper] نتائج البحث: ${results.length}`);
    return results;
  } catch (err: any) {
    await logError({ context: 'searchManga', message: err.message, stack: err.stack });
    throw new Error(`فشل البحث: ${err.message}`);
  }
}

// ─── تفاصيل المانهوا + الفصول ─────────────────────────────────
export async function getMangaDetails(slug: string): Promise<MangaDetails> {
  try {
    const url = `${BASE}/series/${slug}`;
    const html = await fetchHtml(url);

    // العنوان
    const title = extractBetween(html, '<h1 class="entry-title">', '</h1>') ||
                  extractBetween(html, '<title>', ' -') ||
                  slug;

    // الغلاف
    const coverMatch = html.match(/class="thumb"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/);
    const cover = coverMatch ? coverMatch[1] : '';

    // الوصف
    const descRaw = extractBetween(html, '<div class="entry-content">', '</div>') ||
                    extractBetween(html, 'class="description"', '</div>');
    const description = stripTags(descRaw).slice(0, 500);

    // الحالة
    const statusRaw = extractBetween(html, 'الحالة:', '</') ||
                      extractBetween(html, '>مستمرة<', '') ||
                      extractBetween(html, '>مكتملة<', '');
    const status = statusRaw.includes('مكتملة') ? 'مكتملة' : 'مستمرة';

    // التصنيفات من الروابط genre=
    const genreMatches = html.match(/genre=([^"&]+)/g) || [];
    const genres = [...new Set(
      genreMatches.map(g => decodeURIComponent(g.replace('genre=', '')))
    )].slice(0, 6);

    // ─── الفصول ───────────────────────────────────────────────
    // البنية: href="/series/SLUG/رقم"
    // الفصول المدفوعة: الرابط يكون href="#" بدل رابط حقيقي
    const chapterRegex = /href="\/series\/[^/]+\/(\d+)"/g;
    const chapterNums: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = chapterRegex.exec(html)) !== null) {
      chapterNums.push(parseInt(m[1]));
    }

    // إزالة التكرار وترتيب تصاعدي
    const uniqueNums = [...new Set(chapterNums)].sort((a, b) => a - b);

    const chapters: ChapterEntry[] = uniqueNums.map(num => ({
      number: String(num),
      label: `الفصل ${num}`,
      url: `${BASE}/series/${slug}/${num}`,
    }));

    console.log(`[scraper] ${title}: ${chapters.length} فصل مجاني`);

    return {
      title: stripTags(title),
      slug,
      cover,
      description,
      status,
      genres,
      url,
      chapters,
    };
  } catch (err: any) {
    await logError({ context: 'getMangaDetails', message: err.message, stack: err.stack });
    throw new Error(`فشل جلب المانهوا: ${err.message}`);
  }
}

// ─── صور الفصل ────────────────────────────────────────────────
export async function getChapterPages(chapterUrl: string): Promise<ChapterPages> {
  try {
    const html = await fetchHtml(chapterUrl);

    // الصور موجودة بشكل: <img ... src="https://olympustaff.com/uploads/manga_XXX/NUM/file.jpg" ...>
    const imgRegex = /src="(https:\/\/olympustaff\.com\/uploads\/[^"]+\.(jpg|png|webp|gif))"/gi;
    const images: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = imgRegex.exec(html)) !== null) {
      images.push(m[1]);
    }

    // استخراج رقم الفصل من الرابط
    const numMatch = chapterUrl.match(/\/(\d+)\/?$/);
    const chapterNum = numMatch ? numMatch[1] : '?';

    // استخراج اسم الفصل من الصفحة
    const titleRaw = extractBetween(html, '<title>', '</title>');
    const chapterLabel = titleRaw
      ? stripTags(titleRaw).replace('| Team-X', '').trim()
      : `الفصل ${chapterNum}`;

    if (!images.length) throw new Error('لم يتم العثور على صور الفصل');

    console.log(`[scraper] ${chapterLabel}: ${images.length} صورة`);
    return { chapterLabel, images };
  } catch (err: any) {
    await logError({ context: 'getChapterPages', message: err.message, stack: err.stack });
    throw new Error(`فشل جلب صور الفصل: ${err.message}`);
  }
}
