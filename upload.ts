import path from 'path';
import fs from 'fs-extra';
import multer from 'multer';
import unzipper from 'unzipper';
import sharp from 'sharp';

import {
  CHAPTERS_DIR,
  TMP_DIR,
  UPLOADS_DIR,
  ChapterManifest,
  ensureBaseDirs,
  naturalCompare,
  slugify,
  isImageFile,
  isZipFile
} from './utils';

// 200MB كحد أقصى احترازي — الاستخدام الفعلي أقل بكثير (20-70MB)
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);
const MAX_SLICE_HEIGHT = Number(process.env.MAX_SLICE_HEIGHT || 1800);

// أي صورة عرضها أو طولها أصغر من كذا تُستبعد تلقائياً (أيقونات، شعارات، صور دخيلة
// من أدوات استخراج صور صفحات الويب مثل mhtml extractors). صفحات المانهوا الحقيقية
// عادة لا يقل عرضها عن 500-800px، فهذا الحد آمن وما يلمس صفحات حقيقية.
const MIN_IMAGE_WIDTH = Number(process.env.MIN_IMAGE_WIDTH || 300);
const MIN_IMAGE_HEIGHT = Number(process.env.MIN_IMAGE_HEIGHT || 300);

// ملاحظة: معالجة الصور تتم بشكل متسلسل (صورة وحدة في كل مرة) عمداً —
// هذا يحافظ على استهلاك ذاكرة منخفض وثابت بدل التوازي، وهو مناسب
// لموارد Render المجانية المحدودة (512MB RAM)

export const uploadMiddleware = multer({
  dest: TMP_DIR,
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024
  }
});

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkFiles(fullPath));
    } else {
      out.push(fullPath);
    }
  }

  return out;
}

// ─── فلترة الصور الدخيلة ──────────────────────────────────────
// تستبعد: ملفات النظام (__MACOSX, .DS_Store)، manifest.json، وأي صورة
// أبعادها أصغر من الحد الأدنى (أيقونات/شعارات/صور دخيلة من أدوات
// استخراج صور صفحات الويب مثل mhtml extractors)
function isJunkPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('__MACOSX/')) return true;

  const base = path.basename(filePath);
  if (base === '.DS_Store') return true;
  if (base === 'manifest.json') return true;
  if (base.startsWith('.')) return true;

  return false;
}

async function isLikelyJunkImage(imagePath: string): Promise<boolean> {
  try {
    const meta = await sharp(imagePath, { limitInputPixels: false }).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;

    if (!width || !height) return true; // ملف صورة تالف/غير قابل للقراءة

    // منطق "أو": نستبعد لو أي بُعد من الاثنين أصغر من الحد الأدنى.
    // صفحات الفصول الحقيقية عرضها وطولها كبيرين معاً عادة (800px+ عرض)،
    // بينما الأيقونات/الشعارات الدخيلة صغيرة في الاثنين أو في واحد منهم
    if (width < MIN_IMAGE_WIDTH || height < MIN_IMAGE_HEIGHT) return true;

    return false;
  } catch {
    return true; // لو فشلت قراءة الصورة، نعتبرها غير صالحة ونستبعدها
  }
}

async function extractZip(zipPath: string, destDir: string) {
  await fs.ensureDir(destDir);
  await fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: destDir }))
    .promise();
}

async function filterChapterImages(imagePaths: string[]): Promise<string[]> {
  const valid: string[] = [];

  for (const imagePath of imagePaths) {
    if (isJunkPath(imagePath)) continue;
    if (await isLikelyJunkImage(imagePath)) continue;
    valid.push(imagePath);
  }

  return valid;
}

async function splitTallImage(imagePath: string, outDir: string): Promise<string[]> {
  // نقرأ الـ metadata فقط أول (سريع وخفيف، ما يفك الصورة كاملة)
  const probe = sharp(imagePath, { limitInputPixels: false });
  const meta = await probe.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  if (!width || !height) return [imagePath];
  if (height <= MAX_SLICE_HEIGHT) return [imagePath];

  const stem = path.parse(imagePath).name;
  const ext = path.parse(imagePath).ext || '.png';
  const slices: string[] = [];

  // ✅ نفتح pipeline واحد فقط ونستخدم clone() لكل قطعة
  // بدل ما نعيد فك تشفير الصورة الكاملة من جديد في كل مرة (كان السبب الرئيسي
  // لارتفاع استهلاك الذاكرة/المعالجة مع الصور الطويلة جداً مثل صفحات المانهوا)
  const source = sharp(imagePath, { limitInputPixels: false, sequentialRead: true });

  let sliceIndex = 1;
  for (let top = 0; top < height; top += MAX_SLICE_HEIGHT) {
    const sliceHeight = Math.min(MAX_SLICE_HEIGHT, height - top);
    const outPath = path.join(outDir, `${stem}_${String(sliceIndex).padStart(2, '0')}${ext}`);

    await source
      .clone()
      .extract({ left: 0, top, width, height: sliceHeight })
      .toFile(outPath);

    slices.push(outPath);
    sliceIndex += 1;
  }

  return slices;
}

export async function processChapterZip(
  zipPath: string,
  originalName: string,
  titleInput: string
) {
  await ensureBaseDirs();

  if (!isZipFile(originalName)) {
    throw new Error('Only ZIP files are allowed');
  }

  const chapterTitle = titleInput.trim() || path.parse(originalName).name;
  const chapterId = slugify(chapterTitle);
  const chapterDir = path.join(CHAPTERS_DIR, chapterId);
  const extractedDir = path.join(chapterDir, 'extracted');
  const pagesDir = path.join(chapterDir, 'pages');
  const manifestPath = path.join(chapterDir, 'manifest.json');

  await fs.remove(chapterDir);
  await fs.ensureDir(extractedDir);
  await fs.ensureDir(pagesDir);

  await extractZip(zipPath, extractedDir);

  const candidateFiles = (await walkFiles(extractedDir))
    .filter(isImageFile)
    .sort(naturalCompare);

  // ✅ نستبعد الصور الدخيلة (أيقونات/شعارات صغيرة + ملفات نظام/manifest)
  // قبل المعالجة — هذي عادة تأتي من أدوات استخراج صور صفحات الويب
  // (mhtml وغيرها) وتسبب خلط في ترتيب الفصل وتضخم غير منطقي بعدد الصفحات
  const files = await filterChapterImages(candidateFiles);
  const skippedCount = candidateFiles.length - files.length;

  // ننظف الصور الدخيلة من القرص فوراً بما إنها مو محتاجينها
  for (const candidate of candidateFiles) {
    if (!files.includes(candidate)) {
      await fs.remove(candidate).catch(() => {});
    }
  }

  if (skippedCount > 0) {
    console.log(`[upload] Skipped ${skippedCount} junk/icon image(s) for chapter "${chapterTitle}"`);
  }

  const finalImages: string[] = [];

  for (const imagePath of files) {
    const pieces = await splitTallImage(imagePath, pagesDir);

    for (const piece of pieces) {
      const finalName = path.basename(piece);
      const finalPath = path.join(pagesDir, finalName);

      if (piece !== finalPath) {
        await fs.copy(piece, finalPath, { overwrite: true });
      }

      finalImages.push(path.relative(chapterDir, finalPath));
    }

    // ننظف الصورة الأصلية فوراً بدل ما تتراكم مع النسخ المقسّمة
    // حتى نهاية العملية — يقلل أقصى استخدام للقرص مع ملفات ZIP كبيرة
    await fs.remove(imagePath).catch(() => {});
  }

  // ─── ترتيب نهائي ─────────────────────────────────────────
  // المشكلة: naturalCompare يرتب '010_01' قبل '010' لأن '_' < '.' في Unicode،
  // فلازم نوحّد أسماء الملفات للمقارنة فقط بإزالة اللاحقة + صفر بادئ للرقم
  finalImages.sort((a, b) => {
    const normalize = (p: string) => {
      // pages/010_02.jpg → 010_02 → للمقارنة
      const base = path.basename(p, path.extname(p));
      // نحوّل أي رقم في الاسم لـ 4 خانات (010 → 0010، 010_02 → 0010_02)
      return base.replace(/\d+/g, (n) => n.padStart(4, '0'));
    };
    return normalize(a).localeCompare(normalize(b));
  });

  const manifest: ChapterManifest = {
    id: chapterId,
    title: chapterTitle,
    sourceZipName: originalName,
    createdAt: new Date().toISOString(),
    images: finalImages,
    skippedJunkImages: skippedCount
  };

  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.remove(extractedDir);

  return manifest;
}

export async function listChapters(): Promise<ChapterManifest[]> {
  await ensureBaseDirs();

  const dirs = await fs.readdir(CHAPTERS_DIR);
  const chapters: ChapterManifest[] = [];

  for (const dir of dirs) {
    const manifestPath = path.join(CHAPTERS_DIR, dir, 'manifest.json');
    if (await fs.pathExists(manifestPath)) {
      chapters.push(await fs.readJson(manifestPath));
    }
  }

  chapters.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return chapters;
}

export async function getChapterManifest(chapterId: string): Promise<ChapterManifest | null> {
  const manifestPath = path.join(CHAPTERS_DIR, chapterId, 'manifest.json');
  if (!(await fs.pathExists(manifestPath))) return null;
  return fs.readJson(manifestPath);
}

export async function deleteChapter(chapterId: string) {
  await fs.remove(path.join(CHAPTERS_DIR, chapterId));
}

// ─── تبديل حالة عكس ترتيب الفصل (يُتحكم به من لوحة التحكم) ────
export async function toggleChapterReversed(chapterId: string): Promise<ChapterManifest> {
  const manifestPath = path.join(CHAPTERS_DIR, chapterId, 'manifest.json');
  if (!(await fs.pathExists(manifestPath))) {
    throw new Error('Chapter not found');
  }

  const manifest: ChapterManifest = await fs.readJson(manifestPath);
  manifest.reversed = !manifest.reversed;

  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  return manifest;
}

export function getChapterPagePath(chapterId: string, relativeImagePath: string) {
  return path.join(CHAPTERS_DIR, chapterId, relativeImagePath);
}

export function getChapterRoot(chapterId: string) {
  return path.join(CHAPTERS_DIR, chapterId);
}

export function getUploadsDir() {
  return UPLOADS_DIR;
}