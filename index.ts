import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs-extra';
import { ensureBaseDirs, TMP_DIR, CHAPTERS_DIR } from './utils';
import { createDiscordClient, startDiscordBot } from './discord';
import { createWebApp } from './web';

dotenv.config();

// ─── Cleanup عند التشغيل ──────────────────────────────────────
// لو البوت طاح وسط معالجة ZIP، مجلد extracted/ يفضل على القرص.
// نمسح أي مجلد extracted/ متبقي عند كل إعادة تشغيل
async function startupCleanup() {
  // TMP dir (لو استخدمناه)
  if (await fs.pathExists(TMP_DIR)) {
    await fs.emptyDir(TMP_DIR);
    console.log('[startup] Cleaned tmp dir');
  }

  // extracted/ داخل كل فصل
  const chaptersExist = await fs.pathExists(CHAPTERS_DIR);
  if (!chaptersExist) return;

  const chapterDirs = await fs.readdir(CHAPTERS_DIR);
  for (const dir of chapterDirs) {
    const extractedPath = path.join(CHAPTERS_DIR, dir, 'extracted');
    if (await fs.pathExists(extractedPath)) {
      await fs.remove(extractedPath);
      console.log(`[startup] Cleaned extracted/ in ${dir}`);
    }
  }
}

async function main() {
  await ensureBaseDirs();
  await startupCleanup();

  const discordClient = createDiscordClient();
  const app = createWebApp(discordClient);

  const port = Number(process.env.PORT || 3000);
  const webBaseUrl = process.env.WEB_BASE_URL || `http://localhost:${port}`;

  app.listen(port, () => {
    console.log(`[web] Moonbook running at ${webBaseUrl}`);
  });

  await startDiscordBot(discordClient);
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exit(1);
});