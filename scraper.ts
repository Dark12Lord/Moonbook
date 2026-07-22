// ─── scraper.ts ───────────────────────────────────────────────
// يستخدم olympustaff.com (Team-X) — مانجا عربية مترجمة
// البحث عبر /ajax/search?keyword=... بدون كابتشا

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
      'Accept': 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'ar,en;q=0.9',
      'Referer': BASE,
    },
    signal: AbortSignal.timeout(20_000),
  });
  console.log(`[scraper] ← ${res.status} ${url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

// ─── استخراج نمط متكرر ────────────────────────────────────────
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

function extractBetween(html: string, start: string, end: string): string {
  const s = html.indexOf(start);
  if (s === -1) return '';
  const e = html.indexOf(end, s + start.length);
  if (e === -1) return '';
  return html.slice(s + start.length, e).trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ─── بحث عبر AJAX endpoint ────────────────────────────────────
export async function searchManga(query: string): Promise<MangaSearchResult[]> {
  try {
    const url = `${BASE}/ajax/search?keyword=${encodeURIComponent(query)}`;
    const html = await fetchHtml(url);

    const results: MangaSearchResult[] = [];

    // كل نتيجة: <a href="https://olympustaff.com/series/SLUG" ...>
    const blockRegex = /<a\s+href="https:\/\/olympustaff\.com\/series\/([^"]+)"[\s\S]*?<\/a>/g;
    let m: RegExpExecArray | null;

    while ((m = blockRegex.exec(html)) !== null) {
      const slug = m[1];
      const block = m[0];

      // العنوان من <h4 ...>العنوان</h4>
      const titleMatch = block.match(/<h4[^>]*>\s*([^<]+)\s*<\/h4>/);
      const title = titleMatch ? titleMatch[1].trim() : slug;

      // الغلاف من src="..."
      const coverMatch = block.match(/src="(https:\/\/olympustaff\.com\/images\/manga\/[^"]+)"/);
      const cover = coverMatch ? coverMatch[1] : '';

      results.push({
        title,
        slug,
        cover,
        url: `${BASE}/series/${slug}`,
      });
    }

    console.log(`[scraper] نتائج البحث عن "${query}": ${results.length}`);
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
    const titleMatch = html.match(/<h1[^>]*>\s*([^<]+)\s*<\/h1>/);
    const title = titleMatch ? titleMatch[1].trim() : slug;

    // الغلاف
    const coverMatch = html.match(/class="thumb"[\s\S]*?src="([^"]+)"/);
    const cover = coverMatch ? coverMatch[1] : '';

    // الوصف
    const descBlock = extractBetween(html, 'class="entry-content"', '</div>') ||
                      extractBetween(html, 'class="description"', '</div>');
    const description = stripTags(descBlock).slice(0, 500);

    // الحالة
    const status = html.includes('مستمرة') ? 'مستمرة' : html.includes('مكتملة') ? 'مكتملة' : 'غير معروف';

    // التصنيفات
    const genreMatches = html.match(/genre=([^"&]+)/g) || [];
    const genres = [...new Set(
      genreMatches.map(g => decodeURIComponent(g.replace('genre=', '')))
    )].slice(0, 6);

    // ─── الفصول: نسحب كل الصفحات ─────────────────────────────
    // نكتشف عدد الصفحات من الـ pagination أولاً
    const lastPageMatch = html.match(/page=(\d+)[^"]*"[^>]*>\s*(?:›|»|التالي|Next|\d+)\s*<\/a>\s*<\/li>\s*<\/ul>/);
    const maxPageFromNext = html.match(/page=(\d+)" rel="next"/);
    // نجيب أعلى رقم صفحة من روابط الـ pagination
    const allPageNums = [...html.matchAll(/[?&]page=(\d+)/g)].map(m => parseInt(m[1]));
    const totalPages = allPageNums.length ? Math.max(...allPageNums) + 1 : 1;

    console.log(`[scraper] إجمالي الصفحات: ${totalPages}`);

    // دالة مساعدة تسحب أرقام الفصول المجانية من HTML صفحة واحدة
    const slugEscaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    function extractChapNums(pageHtml: string): number[] {
      const re = new RegExp(`href="(?:${BASE})?/series/${slugEscaped}/(\\d+)"`, 'g');
      const nums: number[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(pageHtml)) !== null) nums.push(parseInt(m[1]));
      return nums;
    }

    // نجمع الفصول من الصفحة الأولى (مسبوقاً) + باقي الصفحات بالتوازي
    const allNums: number[] = extractChapNums(html);

    if (totalPages > 1) {
      const pageUrls = Array.from({ length: totalPages - 1 }, (_, i) =>
        `${BASE}/series/${slug}?page=${i + 2}`
      );
      // نسحب بالتوازي (max 5 في نفس الوقت)
      for (let i = 0; i < pageUrls.length; i += 5) {
        const batch = pageUrls.slice(i, i + 5);
        const pages = await Promise.all(batch.map(u => fetchHtml(u)));
        pages.forEach(p => allNums.push(...extractChapNums(p)));
      }
    }

    const uniqueNums = [...new Set(allNums)].sort((a, b) => a - b);
    const chapters: ChapterEntry[] = uniqueNums.map(num => ({
      number: String(num),
      label: `الفصل ${num}`,
      url: `${BASE}/series/${slug}/${num}`,
    }));

    console.log(`[scraper] ${title}: ${chapters.length} فصل مجاني`);

    return { title, slug, cover, description, status, genres, url, chapters };
  } catch (err: any) {
    await logError({ context: 'getMangaDetails', message: err.message, stack: err.stack });
    throw new Error(`فشل جلب المانهوا: ${err.message}`);
  }
}

// ─── صور الفصل ────────────────────────────────────────────────
export async function getChapterPages(chapterUrl: string): Promise<ChapterPages> {
  try {
    const html = await fetchHtml(chapterUrl);

    // الصور: src="https://olympustaff.com/uploads/..."
    const imgRegex = /src="(https:\/\/olympustaff\.com\/uploads\/[^"]+\.(jpg|png|webp|gif))"/gi;
    const images: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = imgRegex.exec(html)) !== null) {
      images.push(m[1]);
    }

    const numMatch = chapterUrl.match(/\/(\d+)\/?$/);
    const chapterNum = numMatch ? numMatch[1] : '?';
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
