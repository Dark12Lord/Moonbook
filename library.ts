// ─── library.ts ───────────────────────────────────────────────
// إدارة المانهوات المنشورة في ديسكورد (الثابتة في رومات منشورة)

import fs from 'fs-extra';
import path from 'path';
import { ROOT_DIR } from './utils';

const LIBRARY_FILE = path.join(ROOT_DIR, 'library.json');

export interface PublishedManga {
  slug: string;
  title: string;
  cover: string;
  description: string;
  status: string;
  totalChapters: number;
  guildId: string;
  channelId: string;    // الروم الثابت حق المانهوا
  messageId: string;    // ID الرسالة اللي فيها الـ embed + select menu
  publishedAt: string;
}

type LibraryStore = Record<string, PublishedManga>; // slug → PublishedManga

async function load(): Promise<LibraryStore> {
  if (!(await fs.pathExists(LIBRARY_FILE))) return {};
  return fs.readJson(LIBRARY_FILE);
}

async function save(store: LibraryStore): Promise<void> {
  await fs.writeJson(LIBRARY_FILE, store, { spaces: 2 });
}

export async function addPublishedManga(manga: PublishedManga): Promise<void> {
  const store = await load();
  store[manga.slug] = manga;
  await save(store);
}

export async function getPublishedManga(slug: string): Promise<PublishedManga | null> {
  const store = await load();
  return store[slug] ?? null;
}

export async function listPublishedManga(): Promise<PublishedManga[]> {
  const store = await load();
  return Object.values(store).sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );
}

export async function removePublishedManga(slug: string): Promise<void> {
  const store = await load();
  delete store[slug];
  await save(store);
}
