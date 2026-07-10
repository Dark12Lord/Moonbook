// ─── web.ts ───────────────────────────────────────────────────

import express, { Express } from 'express';
import path from 'path';
import fs from 'fs-extra';

import {
  uploadMiddleware,
  processChapterZip,
  listChapters,
  deleteChapter,
  toggleChapterReversed,
} from './upload';
import { escapeHtml, sanitizeChapterId } from './utils';
import { Client } from 'discord.js';
import { publishChapterById } from './reader';
import {
  logChapterUploaded,
  logChapterPublished,
  logChapterDeleted,
  logError,
} from './logger';

export function createWebApp(discordClient: Client): Express {
  const app = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // ─── Health Check ─────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    });
  });

  // ─── الصفحة الرئيسية ─────────────────────────────────────
  app.get('/', async (_req, res) => {
    const chapters = await listChapters();

    const rows = chapters.map((ch) => {
      const isReversed = !!ch.reversed;
      return `
      <tr>
        <td data-label="العنوان">${escapeHtml(ch.title)}</td>
        <td data-label="ID"><code>${escapeHtml(ch.id)}</code></td>
        <td data-label="الصفحات">${ch.images.length}</td>
        <td data-label="إجراءات" class="actions">
          <form method="post" action="/publish/${encodeURIComponent(ch.id)}">
            <button type="submit" class="btn-publish">نشر</button>
          </form>
          <form method="post" action="/toggle-reverse/${encodeURIComponent(ch.id)}">
            <button type="submit" class="btn-toggle ${isReversed ? 'on' : 'off'}" title="${isReversed ? 'الترتيب معكوس حالياً' : 'الترتيب طبيعي حالياً'}">
              🔄 عكس الترتيب: ${isReversed ? 'مفعّل' : 'مطفي'}
            </button>
          </form>
          <form method="post" action="/delete/${encodeURIComponent(ch.id)}">
            <button type="submit" class="btn-delete">حذف</button>
          </form>
        </td>
      </tr>
    `;
    }).join('');

    res.send(`
      <html>
        <head>
          <title>Moonbook</title>
          <meta charset="utf-8"/>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            * { box-sizing: border-box; }
            body {
              font-family: system-ui, -apple-system, 'Segoe UI', Tahoma, sans-serif;
              margin: 0;
              padding: 16px;
              background:#0f1115;
              color:#e8e8ea;
            }
            .card {
              max-width: 980px;
              margin: 0 auto;
              background:#171a21;
              border:1px solid #2a2f3a;
              padding:20px;
              border-radius:16px;
            }
            h1 { font-size: 1.5rem; margin: 0 0 4px; }
            h2 { font-size: 1.15rem; }
            .muted { color:#a9afbd; font-size: 0.92rem; }

            label { display:block; margin-top:10px; font-size:0.92rem; color:#cfd3da; }
            input, button { font-size:16px; }
            input[type=text] {
              width:100%; padding:12px; margin:6px 0;
              border-radius:10px; border:1px solid #333;
              background:#10131a; color:white;
            }
            input[type=file] { width:100%; padding:8px 0; color:#cfd3da; }

            button {
              padding:10px 14px; border:0; border-radius:10px;
              cursor:pointer; background:#4a7dff; color:white;
              font-weight: 600; white-space: nowrap;
            }
            button:active { transform: translateY(1px); }

            .btn-publish { background:#4a7dff; }
            .btn-delete  { background:#e03c3c; }
            .btn-toggle.off { background:#3a3f4b; color:#cfd3da; }
            .btn-toggle.on  { background:#f0a93c; color:#1a1300; }

            form { display:inline-block; margin:4px 4px 0 0; }
            .actions { display:flex; flex-wrap:wrap; gap:6px; }
            .actions form { margin:0; }

            /* ─── Progress Bar ─────────────────────────────── */
            #uploadProgressWrap {
              display:none; margin-top:14px;
              background:#10131a; border-radius:10px;
              border:1px solid #2a2f3a; overflow:hidden;
            }
            #uploadProgressBar {
              height: 22px; width:0%; background: linear-gradient(90deg,#4a7dff,#7c5cff);
              transition: width .15s ease; display:flex; align-items:center;
              justify-content:center; font-size:12px; color:white; font-weight:600;
            }
            #uploadStatus { font-size: 0.85rem; color:#a9afbd; margin-top:6px; }

            table { width:100%; border-collapse:collapse; margin-top:18px; }
            th, td { border-bottom:1px solid #2a2f3a; padding:10px; text-align:right; vertical-align: middle; }
            th { font-size:0.85rem; color:#a9afbd; font-weight:600; }

            /* ─── Mobile: نحول الجدول لبطاقات ─────────────── */
            @media (max-width: 640px) {
              body { padding: 10px; }
              .card { padding: 14px; border-radius: 12px; }
              table, thead, tbody, th, tr, td { display:block; }
              thead { display:none; }
              tbody tr {
                background:#10131a; border:1px solid #2a2f3a;
                border-radius:12px; margin-bottom:12px; padding:10px;
              }
              tbody td {
                border:0; padding:6px 4px; display:flex;
                justify-content:space-between; align-items:center; gap:8px;
              }
              tbody td::before {
                content: attr(data-label);
                font-size:0.78rem; color:#7a8094; font-weight:600;
              }
              tbody td.actions { flex-direction:column; align-items:stretch; }
              tbody td.actions::before { margin-bottom:4px; }
              tbody td.actions form { width:100%; }
              tbody td.actions button { width:100%; }
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>🌙 Moonbook</h1>
            <p class="muted">ارفع فصل ZIP، استخرجه، قسّم الصور الطويلة، وانشر في Discord.</p>

            <form id="uploadForm">
              <label>عنوان الفصل</label>
              <input type="text" name="title" id="titleInput" placeholder="Solo Leveling - Chapter 1" />
              <label>ملف ZIP</label>
              <input type="file" name="chapterZip" id="zipInput" accept=".zip" />
              <div style="margin-top:14px;">
                <button type="submit" id="uploadBtn">رفع الفصل</button>
              </div>

              <div id="uploadProgressWrap">
                <div id="uploadProgressBar">0%</div>
              </div>
              <div id="uploadStatus"></div>
            </form>

            <h2 style="margin-top:22px;">الفصول</h2>
            <table>
              <thead>
                <tr><th>العنوان</th><th>ID</th><th>الصفحات</th><th>إجراءات</th></tr>
              </thead>
              <tbody>
                ${rows || '<tr><td colspan="4" class="muted">لا يوجد فصول بعد</td></tr>'}
              </tbody>
            </table>
          </div>

          <script>
            const form = document.getElementById('uploadForm');
            const progressWrap = document.getElementById('uploadProgressWrap');
            const progressBar = document.getElementById('uploadProgressBar');
            const status = document.getElementById('uploadStatus');
            const uploadBtn = document.getElementById('uploadBtn');

            form.addEventListener('submit', function (e) {
              e.preventDefault();

              const zipInput = document.getElementById('zipInput');
              if (!zipInput.files || !zipInput.files.length) {
                status.textContent = 'اختر ملف ZIP أولاً';
                return;
              }

              const formData = new FormData();
              formData.append('title', document.getElementById('titleInput').value);
              formData.append('chapterZip', zipInput.files[0]);

              const xhr = new XMLHttpRequest();
              xhr.open('POST', '/upload');

              progressWrap.style.display = 'block';
              uploadBtn.disabled = true;
              status.textContent = 'جاري رفع الملف...';

              xhr.upload.addEventListener('progress', function (evt) {
                if (evt.lengthComputable) {
                  const percent = Math.round((evt.loaded / evt.total) * 100);
                  progressBar.style.width = percent + '%';
                  progressBar.textContent = percent + '%';
                  if (percent >= 100) {
                    status.textContent = 'جاري معالجة الصور على السيرفر... قد يستغرق وقتاً حسب الحجم';
                  }
                }
              });

              xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 400) {
                  progressBar.style.width = '100%';
                  progressBar.textContent = '✓ تم';
                  status.textContent = 'تم الرفع بنجاح، جاري التحديث...';
                  setTimeout(() => window.location.reload(), 600);
                } else {
                  uploadBtn.disabled = false;
                  status.textContent = 'فشل الرفع: ' + xhr.responseText;
                }
              };

              xhr.onerror = function () {
                uploadBtn.disabled = false;
                status.textContent = 'فشل الاتصال بالسيرفر';
              };

              xhr.send(formData);
            });
          </script>
        </body>
      </html>
    `);
  });

  // ─── رفع فصل ─────────────────────────────────────────────
  app.post('/upload', uploadMiddleware.single('chapterZip'), async (req, res) => {
    try {
      const title = String(req.body.title || '').trim();
      const file = req.file;

      if (!file) return res.status(400).send('لم يتم رفع ملف ZIP');

      const tempZip = file.path;
      const finalZip = path.join(process.cwd(), 'uploads', `${Date.now()}-${file.originalname}`);
      await fs.ensureDir(path.dirname(finalZip));
      await fs.move(tempZip, finalZip, { overwrite: true });

      const manifest = await processChapterZip(finalZip, file.originalname, title);
      await fs.remove(finalZip);

      const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
      await logChapterUploaded({
        title: manifest.title,
        pages: manifest.images.length,
        fileName: file.originalname,
        sizeMb,
        skippedJunk: manifest.skippedJunkImages,
      });

      res.redirect('/');
    } catch (error: any) {
      console.error(error);
      await logError({ context: 'POST /upload', message: error.message, stack: error.stack });
      res.status(500).send(`فشل الرفع: ${escapeHtml(error.message)}`);
    }
  });

  // ─── نشر فصل ─────────────────────────────────────────────
  app.post('/publish/:chapterId', async (req, res) => {
    const chapterId = sanitizeChapterId(req.params.chapterId);
    if (!chapterId) return res.status(400).send('معرّف الفصل غير صالح');

    try {
      await publishChapterById(discordClient, chapterId, 'Web Panel');

      const chapters = await listChapters();
      const chapter = chapters.find((ch) => ch.id === chapterId);
      await logChapterPublished({
        title: chapter?.title ?? chapterId,
        pages: chapter?.images.length ?? 0,
        publishedBy: 'Web Panel',
      });

      res.redirect('/');
    } catch (error: any) {
      console.error(error);
      await logError({ context: 'POST /publish', message: error.message, stack: error.stack });
      res.status(500).send(`فشل النشر: ${escapeHtml(error.message)}`);
    }
  });

  // ─── تبديل عكس الترتيب ────────────────────────────────────
  app.post('/toggle-reverse/:chapterId', async (req, res) => {
    const chapterId = sanitizeChapterId(req.params.chapterId);
    if (!chapterId) return res.status(400).send('معرّف الفصل غير صالح');

    try {
      await toggleChapterReversed(chapterId);
      res.redirect('/');
    } catch (error: any) {
      console.error(error);
      await logError({ context: 'POST /toggle-reverse', message: error.message, stack: error.stack });
      res.status(500).send(`فشل التبديل: ${escapeHtml(error.message)}`);
    }
  });

  // ─── حذف فصل ─────────────────────────────────────────────
  app.post('/delete/:chapterId', async (req, res) => {
    const chapterId = sanitizeChapterId(req.params.chapterId);
    if (!chapterId) return res.status(400).send('معرّف الفصل غير صالح');

    try {
      const chapters = await listChapters();
      const chapter = chapters.find((ch) => ch.id === chapterId);

      await deleteChapter(chapterId);
      await logChapterDeleted({
        title: chapter?.title ?? chapterId,
        deletedBy: 'Web Panel',
      });

      res.redirect('/');
    } catch (error: any) {
      console.error(error);
      await logError({ context: 'POST /delete', message: error.message, stack: error.stack });
      res.status(500).send(`فشل الحذف: ${escapeHtml(error.message)}`);
    }
  });

  // ─── Manifest API ─────────────────────────────────────────
  app.get('/chapter/:chapterId/manifest', async (req, res) => {
    const chapterId = sanitizeChapterId(req.params.chapterId);
    if (!chapterId) return res.status(400).json({ error: 'معرّف غير صالح' });

    const manifestPath = path.join(process.cwd(), 'chapters', chapterId, 'manifest.json');
    if (!(await fs.pathExists(manifestPath))) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(await fs.readJson(manifestPath));
  });

  return app;
}
