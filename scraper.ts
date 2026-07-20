// ─── scraper.ts ───────────────────────────────────────────────
// سحب بيانات المانهوا والفصول من mangalik.net
// الموقع مبني على WordPress + Madara theme — بنية ثابتة ومستقرة

import { logError } from './logger';

const BASE_URL = 'https://manga-starz.com';  // يفتح بدون Captcha، نفس بنية mangalik.net
const MANGA_BASE = 'https://manga-starz.net'; // الدومين الأصلي للفصول
const IMG_BASE   = 'starz.manga-starz.net';   // سيرفر الصور
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': BASE_URL,
  'Accept-Language': 'ar,en;q=0.9',
};

// ─── Types ────────────────────────────────────────────────────

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
  number: string;   // "1", "2", "10.5"...
  label: string;    // "الفصل 1"
  url: string;
}

export interface ChapterPages {
  chapterLabel: string;
  images: string[];
}

// ─── helpers ──────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.text();
}

// Madara theme يضع الصور إما في src أو data-src (lazy loading)
function extractImgSrc(tag: string): string {
  const dataSrc = tag.match(/data-src=["']([^"']+)["']/)?.[1];
  const src     = tag.match(/\bsrc=["']([^"']+)["']/)?.[1];
  return (dataSrc || src || '').trim();
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// ─── بحث عن مانهوا ────────────────────────────────────────────

export async function searchManga(query: string): Promise<MangaSearchResult[]> {
  const url = `${BASE_URL}/?s=${encodeURIComponent(query)}&post_type=wp-manga`;

  try {
    const html = await fetchHtml(url);
    const results: MangaSearchResult[] = [];

    // بنية Madara الفعلية: كل مانهوا داخل div.c-image-hover + h3.h5
    // <div class="c-image-hover"><a href="URL"><img src="..." data-src="..."></a></div>
    // <h3 class="h5"><a href="URL">العنوان</a></h3>
    const cardRegex = /<div[^>]+class="[^"]*c-image-hover[^"]*"[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>\s*(<img[^>]+>)/g;
    const titleRegex = /<h3[^>]+class="[^"]*h5[^"]*"[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/g;

    // نجمع العناوين أولاً
    const titlesMap = new Map<string, string>();
    let tMatch: RegExpExecArray | null;
    while ((tMatch = titleRegex.exec(html)) !== null) {
      const tUrl = tMatch[1].trim();
      const title = decodeHtmlEntities(tMatch[2].trim());
      titlesMap.set(tUrl, title);
    }

    // نجمع الصور والروابط
    let cMatch: RegExpExecArray | null;
    while ((cMatch = cardRegex.exec(html)) !== null && results.length < 10) {
      const mangaUrl = cMatch[1].trim();
      const imgTag   = cMatch[2];
      const cover    = extractImgSrc(imgTag)
        .replace(/\-\d+x\d+(\.\w+)$/, '$1'); // نزيل الـ resize suffix

      const slugMatch = mangaUrl.match(/\/manga\/([^/]+)\/?$/);
      if (!slugMatch) continue;
      const slug  = slugMatch[1];
      const title = titlesMap.get(mangaUrl) || slug;

      results.push({ title, slug, cover, url: mangaUrl });
    }

    return results;
  } catch (err: any) {
    await logError({ context: 'searchManga', message: err.message, stack: err.stack });
    throw new Error(`فشل البحث: ${err.message}`);
  }
}

// ─── تفاصيل المانهوا + قائمة الفصول ──────────────────────────

export async function getMangaDetails(slug: string): Promise<MangaDetails> {
  const url = `${BASE_URL}/manga/${slug}/`;

  try {
    const html = await fetchHtml(url);

    // ─── العنوان ──────────────────────────────────────────────
    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const title = titleMatch
      ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim())
      : slug;

    // ─── الغلاف ───────────────────────────────────────────────
    const coverMatch = html.match(/class="[^"]*summary_image[^"]*"[\s\S]*?<img([^>]+)>/);
    const rawCover   = coverMatch ? extractImgSrc(`<img${coverMatch[1]}>`) : '';
    // نزيل الـ resize suffix (-193x278) لنحصل على الصورة الكاملة
    const cover = rawCover.replace(/-\d+x\d+(\.\w+)$/, '$1');

    // ─── الوصف ────────────────────────────────────────────────
    const descMatch = html.match(/class="[^"]*summary__content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const description = descMatch
      ? decodeHtmlEntities(descMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).slice(0, 400)
      : '';

    // ─── الحالة ───────────────────────────────────────────────
    const statusMatch = html.match(/class="[^"]*post-status[^"]*"[\s\S]*?class="[^"]*summary-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const status = statusMatch
      ? statusMatch[1].replace(/<[^>]+>/g, '').trim()
      : 'غير معروف';

    // ─── التصنيفات ────────────────────────────────────────────
    const genreMatch = html.match(/class="[^"]*genres-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const genres: string[] = [];
    if (genreMatch) {
      for (const g of genreMatch[1].matchAll(/<a[^>]*>([^<]+)<\/a>/g)) {
        genres.push(g[1].trim());
      }
    }

    // ─── الفصول — موجودة مباشرة في الـ HTML ─────────────────
    // البنية: <li class="...wp-manga-chapter..."><a href="URL">العنوان</a>
    const chapters: ChapterEntry[] = [];
    const chapterRegex = /<li[^>]*wp-manga-chapter[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g;
    let chapMatch: RegExpExecArray | null;

    while ((chapMatch = chapterRegex.exec(html)) !== null) {
      const chapUrl   = chapMatch[1].trim();
      const chapLabel = decodeHtmlEntities(chapMatch[2].replace(/<[^>]+>/g, '').trim());
      const numMatch  = chapUrl.match(/\/(\d+(?:[.-]\d+)?)\/?$/);
      const number    = numMatch ? numMatch[1].replace('-', '.') : chapLabel;

      if (chapUrl && chapLabel) {
        chapters.push({
          number,
          label: chapLabel || `الفصل ${number}`,
          url: chapUrl,
        });
      }
    }

    // Madara يعرضها من الأحدث للأقدم — نعكس للترتيب الصحيح
    chapters.reverse();

    return { title, slug, cover, description, status, genres, url, chapters };
  } catch (err: any) {
    await logError({ context: 'getMangaDetails', message: err.message, stack: err.stack });
    throw new Error(`فشل جلب تفاصيل المانهوا: ${err.message}`);
  }
}

// ─── صور الفصل ────────────────────────────────────────────────

export async function getChapterPages(chapterUrl: string): Promise<ChapterPages> {
  // روابط الفصول على manga-starz.net — نستخدم manga-starz.com لتجاوز أي حماية
  const fetchUrl = chapterUrl.replace('manga-starz.net', 'manga-starz.com');

  try {
    const html = await fetchHtml(fetchUrl);

    // العنوان
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    const chapterLabel = titleMatch
      ? decodeHtmlEntities(titleMatch[1].split('|')[0].trim())
      : 'فصل';

    // الصور في div.reading-content أو div.page-break
    // الموقع يستخدم io.mangalik.net كسيرفر للصور
    const images: string[] = [];
    const imgRegex = /<img[^>]+>/g;
    let imgMatch: RegExpExecArray | null;

    while ((imgMatch = imgRegex.exec(html)) !== null) {
      const tag = imgMatch[0];
      const src = extractImgSrc(tag);

      if (!src || !src.startsWith('http')) continue;

      // نفلتر فقط صور الفصل الفعلية (على io.mangalik.net أو s*solo.mangalik.net)
      const isChapterImage = src.includes('starz.manga-starz.net') || src.includes('manga-starz.net/wp-content/uploads');
      if (!isChapterImage) continue;

      // نستبعد الأيقونات والشعارات والأغلفة الصغيرة
      if (src.includes('cropped') || src.includes('logo') || src.includes('-110x150') || src.includes('270x270')) continue;

      if (!images.includes(src)) {
        images.push(src);
      }
    }

    if (!images.length) throw new Error('لم يتم العثور على صور في هذا الفصل');

    return { chapterLabel, images };
  } catch (err: any) {
    await logError({ context: 'getChapterPages', message: err.message, stack: err.stack });
    throw new Error(`فشل جلب صور الفصل: ${err.message}`);
  }
}
