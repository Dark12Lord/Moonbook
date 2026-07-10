import path from 'path';
import fs from 'fs-extra';

export interface ChapterManifest {
  id: string;
  title: string;
  sourceZipName: string;
  createdAt: string;
  images: string[];
  skippedJunkImages?: number; // عدد الصور المستبعدة تلقائياً (أيقونات/شعارات صغيرة)
  reversed?: boolean; // هل نعرض الفصل بترتيب معكوس (يُتحكم به من لوحة التحكم)
}

export interface ReaderSession {
  sessionId: string;
  chapterId: string;
  channelId: string;
  roomChannelId?: string;    // ID روم القراءة المؤقت
  messageId?: string;
  title: string;
  pageIndex: number;
  userId: string;            // من فتح الجلسة
  username: string;          // اسمه للوق
  openedAt: number;          // timestamp للـ TTL
}

export const ROOT_DIR = process.cwd();
export const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
export const CHAPTERS_DIR = path.join(ROOT_DIR, 'chapters');
export const TMP_DIR = path.join(ROOT_DIR, 'tmp');

// ─── Session TTL ──────────────────────────────────────────────
export const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6 ساعات

// ─── Helpers ──────────────────────────────────────────────────

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\u0600-\u06FF]+/g, '-')
      .replace(/^-+|-+$/g, '') || `chapter-${Date.now()}`
  ).slice(0, 80);
}

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function isImageFile(filename: string): boolean {
  return /\.(png|jpe?g|webp|avif)$/i.test(filename);
}

export function isZipFile(filename: string): boolean {
  return /\.zip$/i.test(filename);
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function ensureBaseDirs() {
  await fs.ensureDir(UPLOADS_DIR);
  await fs.ensureDir(CHAPTERS_DIR);
  await fs.ensureDir(TMP_DIR);
}

export async function safeRemove(target: string) {
  if (await fs.pathExists(target)) {
    await fs.remove(target);
  }
}

// ─── Admin check ──────────────────────────────────────────────
const ADMIN_IDS = new Set(
  (process.env.ADMINS_ID || '').split(',').map((id) => id.trim()).filter(Boolean)
);

export function isAdmin(userId: string): boolean {
  return ADMIN_IDS.has(userId);
}

// ─── Progress bar ─────────────────────────────────────────────
export function buildProgressBar(current: number, total: number): string {
  const filled = Math.round((current / total) * 10);
  const empty = 10 - filled;
  const bar = '▓'.repeat(filled) + '░'.repeat(empty);
  const percent = Math.round((current / total) * 100);
  return `${bar}  ${current}/${total} • ${percent}%`;
}

// ─── Chapter ID sanitizer ─────────────────────────────────────
export function sanitizeChapterId(id: string): string | null {
  if (!/^[a-z0-9\u0600-\u06FF\-]{1,80}$/.test(id)) return null;
  return id;
}

// ─── ترتيب الصور الفعّال (مع مراعاة فلاق reversed) ────────────
// نعكس ترتيب "الصور الأصلية" (المجموعات) فقط، مع الحفاظ على ترتيب
// القطع الصحيح داخل كل صورة (01, 02, 03...) — مهم لصفحات المانهوا
// الطويلة المقسّمة لعدة قطع
export function getEffectiveImages(chapter: ChapterManifest): string[] {
  if (!chapter.reversed) return chapter.images;

  const groups = new Map<string, string[]>();
  const groupOrder: string[] = [];

  for (const img of chapter.images) {
    // المفتاح = اسم الصورة الأصلية بدون لاحقة القطعة (_01, _02...)
    const stem = path.basename(img).replace(/_\d+(\.[a-zA-Z0-9]+)$/, '$1');
    if (!groups.has(stem)) {
      groups.set(stem, []);
      groupOrder.push(stem);
    }
    groups.get(stem)!.push(img);
  }

  groupOrder.reverse();
  const result: string[] = [];
  for (const stem of groupOrder) {
    result.push(...groups.get(stem)!);
  }
  return result;
}
