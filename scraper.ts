// ─── scraper.ts ───────────────────────────────────────────────
// سحب بيانات المانهوا والفصول من mangalik.net
// الموقع مبني على WordPress + Madara theme — بنية ثابتة ومستقرة

import { logError } from './logger';

const BASE_URL = 'https://mangalik.net';
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

    // Madara search results: div.c-tabs-item__content أو div.row.c-tabs-item__content
    const itemRegex = /<div[^>]+class="[^"]*tab-thumb[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]+class="[^"]*tab-summary[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(html)) !== null && results.length < 10) {
      const thumbBlock   = match[1];
      const summaryBlock = match[2];

      // الغلاف
      const imgMatch = thumbBlock.match(/<img[^>]+>/);
      const cover = imgMatch ? extractImgSrc(imgMatch[0]) : '';

      // الرابط والعنوان
      const linkMatch = summaryBlock.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/);
      if (!linkMatch) continue;

      const mangaUrl = linkMatch[1].trim();
      const title = decodeHtmlEntities(linkMatch[2].replace(/<[^>]+>/g, '').trim());

      // slug من الرابط
      const slugMatch = mangaUrl.match(/\/manga\/([^/]+)\/?$/);
      if (!slugMatch) continue;
      const slug = slugMatch[1];

      if (title && slug) {
        results.push({ title, slug, cover, url: mangaUrl });
      }
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
    const titleMatch = html.match(/<h1[^>]*class="[^"]*post-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
    const title = titleMatch
      ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim())
      : slug;

    // ─── الغلاف ───────────────────────────────────────────────
    const coverMatch = html.match(/class="[^"]*summary_image[^"]*"[\s\S]*?<img([^>]+)>/);
    const cover = coverMatch ? extractImgSrc(`<img${coverMatch[1]}>`) : '';

    // ─── الوصف ────────────────────────────────────────────────
    const descMatch = html.match(/class="[^"]*summary__content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const description = descMatch
      ? decodeHtmlEntities(descMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).slice(0, 400)
      : '';

    // ─── الحالة ───────────────────────────────────────────────
    const statusMatch = html.match(/class="[^"]*post-status[^"]*"[\s\S]*?<div[^>]*class="[^"]*summary-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const status = statusMatch
      ? statusMatch[1].replace(/<[^>]+>/g, '').trim()
      : 'غير معروف';

    // ─── التصنيفات ────────────────────────────────────────────
    const genreMatch = html.match(/class="[^"]*genres-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const genres: string[] = [];
    if (genreMatch) {
      const genreLinks = genreMatch[1].matchAll(/<a[^>]*>([^<]+)<\/a>/g);
      for (const g of genreLinks) genres.push(g[1].trim());
    }

    // ─── قائمة الفصول (Madara يحطها في li.wp-manga-chapter) ──
    const chapters: ChapterEntry[] = [];
    const chapterRegex = /<li[^>]+class="[^"]*wp-manga-chapter[^"]*"[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g;
    let chapMatch: RegExpExecArray | null;

    while ((chapMatch = chapterRegex.exec(html)) !== null) {
      const chapUrl   = chapMatch[1].trim();
      const chapLabel = decodeHtmlEntities(chapMatch[2].replace(/<[^>]+>/g, '').trim());

      // نستخرج الرقم من الرابط
      const numMatch = chapUrl.match(/\/(\d+(?:\.\d+)?)\/?$/);
      const number = numMatch ? numMatch[1] : chapLabel;

      chapters.push({ number, label: chapLabel || `الفصل ${number}`, url: chapUrl });
    }

    // Madara يعرضها من الأحدث للأقدم — نعكس للترتيب الطبيعي
    chapters.reverse();

    return { title, slug, cover, description, status, genres, url, chapters };
  } catch (err: any) {
    await logError({ context: 'getMangaDetails', message: err.message, stack: err.stack });
    throw new Error(`فشل جلب تفاصيل المانهوا: ${err.message}`);
  }
}

// ─── صور الفصل ────────────────────────────────────────────────

export async function getChapterPages(chapterUrl: string): Promise<ChapterPages> {
  try {
    const html = await fetchHtml(chapterUrl);

    // العنوان
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    const chapterLabel = titleMatch
      ? decodeHtmlEntities(titleMatch[1].split('|')[0].trim())
      : 'فصل';

    // الصور: الموقع يضعها في div.page-break img أو div.reading-content img
    const images: string[] = [];
    const imgRegex = /<img[^>]+>/g;
    let imgMatch: RegExpExecArray | null;

    while ((imgMatch = imgRegex.exec(html)) !== null) {
      const tag = imgMatch[0];
      // نفلتر فقط صور الفصل — تكون على سيرفر s*solo.mangalik.net
      if (!tag.includes('mangalik.net') && !tag.includes('solo.mangalik')) continue;
      // نستبعد الصور الصغيرة (غلاف، شعار)
      if (tag.includes('193x278') || tag.includes('logo') || tag.includes('cropped')) continue;

      const src = extractImgSrc(tag);
      if (src && src.startsWith('http') && !images.includes(src)) {
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
