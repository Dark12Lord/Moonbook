// ─── manga_reader.ts ──────────────────────────────────────────
// نظام قراءة المانهوا المسحوبة من mangalik.net
// منفصل تماماً عن reader.ts (الذي يتعامل مع الملفات المرفوعة)

import crypto from 'crypto';
import path from 'path';
import fs from 'fs-extra';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextChannel,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
} from 'discord.js';

import { buildProgressBar, SESSION_TTL_MS } from './utils';
import { getChapterPages, getMangaDetails, ChapterEntry, MangaDetails } from './scraper';
import { createReadingRoom, deleteReadingRoom } from './room';
import { logRoomOpened, logRoomClosed, logError } from './logger';
import { addPublishedManga, getPublishedManga } from './library';

const CHUNK_SIZE = 25; // حد Discord للـ Select Menu

// ─── Online Session ───────────────────────────────────────────

interface OnlineSession {
  sessionId: string;
  slug: string;
  chapterUrl: string;
  chapterLabel: string;
  roomChannelId: string;
  messageId?: string;
  pageIndex: number;
  images: string[];
  cachedFiles: string[];
  userId: string;
  username: string;
  openedAt: number;
  // التنقل بين الفصول
  chapterUrls: string[];       // قائمة روابط الفصول المجانية بالترتيب
  currentChapterIndex: number; // موقع الفصل الحالي
}

const onlineSessions = new Map<string, OnlineSession>();
const onlineUserSession = new Map<string, string>(); // userId → sessionId

// Cleanup تلقائي
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of onlineSessions) {
    if (now - session.openedAt > SESSION_TTL_MS) {
      cleanupSession(session);
      onlineSessions.delete(id);
      onlineUserSession.delete(session.userId);
    }
  }
}, 1000 * 60 * 30);

async function cleanupSession(session: OnlineSession) {
  // نمسح الملفات المؤقتة
  for (const f of session.cachedFiles) {
    await fs.remove(f).catch(() => {});
  }
}

import sharp from 'sharp';

const MAX_SLICE_HEIGHT = Number(process.env.MAX_SLICE_HEIGHT || 1800);

// ─── تحميل صورة وقصها لو كانت طويلة ─────────────────────────

async function downloadAndSplitImage(url: string, destDir: string): Promise<string[]> {
  const ext  = path.extname(new URL(url).pathname) || '.jpg';
  const base = crypto.randomUUID();
  const dest = path.join(destDir, `${base}${ext}`);

  const res = await fetch(url, {
    headers: {
      'Referer': 'https://olympustaff.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`فشل تحميل الصورة: HTTP ${res.status}`);

  await fs.ensureDir(destDir);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));

  // فحص الارتفاع وقص الصورة لو طويلة
  const meta = await sharp(dest, { limitInputPixels: false }).metadata();
  const height = meta.height ?? 0;
  const width  = meta.width  ?? 0;

  if (!height || height <= MAX_SLICE_HEIGHT) return [dest];

  // نقص الصورة لقطع
  const slices: string[] = [];
  const source = sharp(dest, { limitInputPixels: false, sequentialRead: true });
  let sliceIndex = 1;

  for (let top = 0; top < height; top += MAX_SLICE_HEIGHT) {
    const sliceHeight = Math.min(MAX_SLICE_HEIGHT, height - top);
    const slicePath = path.join(destDir, `${base}_${String(sliceIndex).padStart(2, '0')}${ext}`);
    await source.clone().extract({ left: 0, top, width, height: sliceHeight }).toFile(slicePath);
    slices.push(slicePath);
    sliceIndex++;
  }

  // نحذف الصورة الأصلية الطويلة بعد القص
  await fs.remove(dest);
  return slices;
}

// ─── Buttons القارئ ───────────────────────────────────────────

function makeOnlineButtons(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`omg_first:${sessionId}`)
      .setLabel('⏮').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`omg_prev:${sessionId}`)
      .setLabel('◀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`omg_next:${sessionId}`)
      .setLabel('▶').setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`omg_last:${sessionId}`)
      .setLabel('⏭').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`omg_goto:${sessionId}`)
      .setLabel('🔢').setStyle(ButtonStyle.Secondary),
  );
}

function makeChapterNavButtons(sessionId: string, hasPrev: boolean, hasNext: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`omg_prev_ch:${sessionId}`)
      .setLabel('◀ الفصل السابق')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasPrev),
    new ButtonBuilder()
      .setCustomId(`omg_next_ch:${sessionId}`)
      .setLabel('الفصل التالي ▶')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!hasNext),
    new ButtonBuilder()
      .setCustomId(`omg_close:${sessionId}`)
      .setLabel('✕ أغلق الروم')
      .setStyle(ButtonStyle.Danger),
  );
}

// ─── Embed القارئ ─────────────────────────────────────────────

function buildOnlineEmbed(
  session: OnlineSession,
  imageName: string,
): EmbedBuilder {
  const current = session.pageIndex + 1;
  const total   = session.images.length;
  return new EmbedBuilder()
    .setTitle(`📖 ${session.chapterLabel}`)
    .setDescription(buildProgressBar(current, total))
    .setImage(`attachment://${imageName}`)
    .setColor(0x7c5cff)
    .setFooter({ text: `Moonbook • ${session.slug}` });
}

// ─── إرسال/تعديل صفحة ────────────────────────────────────────

async function sendOnlinePage(
  channel: TextChannel,
  session: OnlineSession,
  edit?: { messageId: string },
): Promise<string> {
  const imageUrl = session.images[session.pageIndex];
  const tmpDir   = path.join(process.cwd(), 'tmp', session.sessionId);

  // تحميل الصورة وقصها لو كانت طويلة
  const slices = await downloadAndSplitImage(imageUrl, tmpDir);
  session.cachedFiles.push(...slices);

  // prefetch الصورة التالية في الخلفية
  const nextUrl = session.images[session.pageIndex + 1];
  if (nextUrl) downloadAndSplitImage(nextUrl, tmpDir)
    .then(fs => session.cachedFiles.push(...fs))
    .catch(() => {});

  // نبني embed بأول قطعة، والباقي كـ attachments إضافية
  const firstSlice = slices[0];
  const firstName  = path.basename(firstSlice);
  const embed = buildOnlineEmbed(session, firstName);
  const files = slices.map(s => new AttachmentBuilder(s, { name: path.basename(s) }));

  const current = session.pageIndex + 1;
  const total   = session.images.length;
  const hasPrev = session.currentChapterIndex > 0;
  const hasNext = session.currentChapterIndex < session.chapterUrls.length - 1;
  const rows = [
    makeOnlineButtons(session.sessionId),
    makeChapterNavButtons(session.sessionId, hasPrev, hasNext),
  ];

  if (edit) {
    await channel.messages.edit(edit.messageId, { embeds: [embed], files, components: rows });
    return edit.messageId;
  } else {
    const msg = await channel.send({ embeds: [embed], files, components: rows });
    return msg.id;
  }
}

// ─── بدء جلسة قراءة فصل ──────────────────────────────────────

export async function startOnlineReading(
  client: Client,
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  slug: string,
  chapterUrl: string,
  chapterLabel: string,
  allChapterUrls?: string[],
): Promise<void> {
  // منع روم مكرر
  const existingId = onlineUserSession.get(interaction.user.id);
  if (existingId) {
    const existing = onlineSessions.get(existingId);
    if (existing?.roomChannelId) {
      await interaction.reply({
        content: [
          '📖 **عندك روم قراءة مفتوح بالفعل!**',
          '',
          `<#${existing.roomChannelId}>`,
          '',
          'أغلقه أول قبل ما تفتح روم جديد.',
        ].join('\n'),
        ephemeral: true,
      });
      return;
    }
    onlineUserSession.delete(interaction.user.id);
  }

  await interaction.reply({ content: '⏳ جاري جلب الفصل... قد يستغرق 30 ثانية في أول طلب.', ephemeral: true });

  try {
    // جلب صور الفصل عبر الـ Proxy
    const { images } = await getChapterPages(chapterUrl);

    const guildId = process.env.DISCORD_GUILD_ID || '';
    const room = await createReadingRoom(
      client, guildId,
      interaction.user.id,
      interaction.user.username,
      slug,
    );

    const sessionId = crypto.randomUUID();
    const chapterUrls = allChapterUrls ?? [chapterUrl];
    const currentChapterIndex = chapterUrls.indexOf(chapterUrl);
    const session: OnlineSession = {
      sessionId,
      slug,
      chapterUrl,
      chapterLabel,
      roomChannelId: room.id,
      pageIndex: 0,
      images,
      cachedFiles: [],
      userId: interaction.user.id,
      username: interaction.user.username,
      openedAt: Date.now(),
      chapterUrls,
      currentChapterIndex: currentChapterIndex >= 0 ? currentChapterIndex : 0,
    };

    onlineSessions.set(sessionId, session);
    onlineUserSession.set(interaction.user.id, sessionId);

    // رسالة ترحيب
    const welcomeEmbed = new EmbedBuilder()
      .setTitle(`📖 ${chapterLabel}`)
      .setDescription(
        [`أهلاً <@${interaction.user.id}>! 👋`, '', `> 🖼️ **${images.length} صفحة**`, '', 'استخدم الأزرار للتنقل • ✕ للإغلاق'].join('\n')
      )
      .setColor(0x7c5cff);
    await room.send({ embeds: [welcomeEmbed] });

    // أول صفحة
    const msgId = await sendOnlinePage(room, session);
    session.messageId = msgId;
    onlineSessions.set(sessionId, session);

    await logRoomOpened({
      username: interaction.user.username,
      userId: interaction.user.id,
      chapterTitle: chapterLabel,
      channelName: room.name,
    });

    await interaction.editReply({
      content: ['📖 **روم القراءة جاهز!**', '', `<#${room.id}>`, '', `استمتع بقراءة **${chapterLabel}** 🎉`].join('\n'),
    });

  } catch (err: any) {
    await logError({ context: 'startOnlineReading', message: err.message, stack: err.stack });
    await interaction.editReply(`❌ فشل فتح الفصل: ${err.message}`);
  }
}

// ─── معالجة أزرار القارئ ──────────────────────────────────────

export async function handleOnlineReaderButton(interaction: ButtonInteraction): Promise<void> {
  const [action, sessionId] = interaction.customId.split(':');
  const session = onlineSessions.get(sessionId);

  if (!session) {
    await interaction.reply({ content: '❌ الجلسة انتهت.', ephemeral: true });
    return;
  }

  const lastIndex = session.images.length - 1;
  const channel   = interaction.channel as TextChannel;

  if (action === 'omg_close') {
    const durationMin = Math.round((Date.now() - session.openedAt) / 60000);
    const pagesRead   = session.pageIndex + 1;
    onlineSessions.delete(sessionId);
    onlineUserSession.delete(session.userId);
    await cleanupSession(session);
    await logRoomClosed({ username: session.username, userId: session.userId, chapterTitle: session.chapterLabel, pagesRead, durationMin });
    await interaction.reply({ content: '🔒 تم إغلاق الروم، إلى اللقاء!', ephemeral: true });
    setTimeout(() => deleteReadingRoom(interaction.client, session.roomChannelId), 2000);
    return;
  }

  if (action === 'omg_goto') {
    const modal = new ModalBuilder()
      .setCustomId(`omg_modal:${sessionId}`)
      .setTitle('انتقل إلى صفحة');
    const input = new TextInputBuilder()
      .setCustomId('page_number')
      .setLabel(`رقم الصفحة (1 – ${session.images.length})`)
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  // ─── التنقل بين الفصول ────────────────────────────────────
  if (action === 'omg_next_ch' || action === 'omg_prev_ch') {
    const newIndex = action === 'omg_next_ch'
      ? session.currentChapterIndex + 1
      : session.currentChapterIndex - 1;

    if (newIndex < 0 || newIndex >= session.chapterUrls.length) {
      await interaction.reply({ content: '❌ لا يوجد فصل في هذا الاتجاه.', ephemeral: true });
      return;
    }

    await interaction.deferUpdate();
    const newUrl = session.chapterUrls[newIndex];
    const newLabel = `فصل من ${session.slug} (${newIndex + 1}/${session.chapterUrls.length})`;

    try {
      const { images, chapterLabel: fetchedLabel } = await getChapterPages(newUrl);
      // مسح الكاش القديم
      for (const f of session.cachedFiles) await fs.remove(f).catch(() => {});

      session.chapterUrl = newUrl;
      session.chapterLabel = fetchedLabel || newLabel;
      session.currentChapterIndex = newIndex;
      session.pageIndex = 0;
      session.images = images;
      session.cachedFiles = [];
      onlineSessions.set(sessionId, session);

      await sendOnlinePage(channel, session, { messageId: interaction.message.id });
    } catch (err: any) {
      await logError({ context: 'omg_next_ch', message: err.message, stack: err.stack });
    }
    return;
  }

  await interaction.deferUpdate();

  if (action === 'omg_first') session.pageIndex = 0;
  else if (action === 'omg_prev') session.pageIndex = Math.max(0, session.pageIndex - 1);
  else if (action === 'omg_next') session.pageIndex = Math.min(lastIndex, session.pageIndex + 1);
  else if (action === 'omg_last') session.pageIndex = lastIndex;

  onlineSessions.set(sessionId, session);

  try {
    await sendOnlinePage(channel, session, { messageId: interaction.message.id });
  } catch (err: any) {
    await logError({ context: 'handleOnlineReaderButton', message: err.message, stack: err.stack });
  }
}

// ─── معالجة Modal انتقال إلى صفحة ────────────────────────────

export async function handleOnlineGotoModal(interaction: ModalSubmitInteraction): Promise<void> {
  const [, sessionId] = interaction.customId.split(':');
  const session = onlineSessions.get(sessionId);
  if (!session) { await interaction.reply({ content: '❌ الجلسة انتهت.', ephemeral: true }); return; }

  const raw = interaction.fields.getTextInputValue('page_number');
  const pageNum = parseInt(raw, 10);
  if (isNaN(pageNum) || pageNum < 1 || pageNum > session.images.length) {
    await interaction.reply({ content: `❌ أدخل رقماً بين 1 و ${session.images.length}.`, ephemeral: true });
    return;
  }

  session.pageIndex = pageNum - 1;
  onlineSessions.set(sessionId, session);
  await interaction.deferUpdate();

  try {
    await sendOnlinePage(interaction.channel as TextChannel, session, { messageId: interaction.message!.id });
  } catch (err: any) {
    await logError({ context: 'handleOnlineGotoModal', message: err.message, stack: err.stack });
  }
}

// ─── بناء رسالة المانهوا (embed + select menus) ───────────────

export async function publishMangaToChannel(
  client: Client,
  channel: TextChannel,
  manga: MangaDetails,
): Promise<string> {
  // ─── Embed المانهوا ───────────────────────────────────────
  const embed = new EmbedBuilder()
    .setTitle(`📚 ${manga.title}`)
    .setDescription(
      [
        manga.description || 'لا يوجد وصف.',
        '',
        `> 📊 **${manga.chapters.length} فصل** • ${manga.status}`,
        manga.genres.length ? `> 🏷️ ${manga.genres.slice(0, 4).join(' • ')}` : '',
      ].filter(Boolean).join('\n')
    );
  if (manga.cover) {
    embed.setThumbnail(manga.cover);
  }
  embed
    .setColor(0x7c5cff)
    .setFooter({ text: `Moonbook • ${manga.slug}` })
    .setTimestamp();

  // ─── Select Menus (كل 25 فصل = منيو) ────────────────────
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

  // إزالة أي فصول بنفس القيمة (value) المكررة — تسبب رفض ديسكورد للطلب بخطأ 500
  const seenValues = new Set<string>();
  const uniqueChapters = manga.chapters.filter(ch => {
    if (seenValues.has(ch.url)) {
      console.warn(`[publish] تجاهلت فصل مكرر: ${ch.url} (${ch.label})`);
      return false;
    }
    seenValues.add(ch.url);
    return true;
  });

  if (uniqueChapters.length !== manga.chapters.length) {
    console.warn(`[publish] عدد الفصول قبل التنظيف: ${manga.chapters.length}, بعد إزالة المكرر: ${uniqueChapters.length}`);
  }

  for (let i = 0; i < uniqueChapters.length && rows.length < 5; i += CHUNK_SIZE) {
    const chunk = uniqueChapters.slice(i, i + CHUNK_SIZE);
    const first = chunk[0].number;
    const last  = chunk[chunk.length - 1].number;

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`omg_select:${manga.slug}:${i}`)
      .setPlaceholder(`📖 الفصول ${first} – ${last}`)
      .addOptions(
        chunk.map(ch =>
          new StringSelectMenuOptionBuilder()
            .setLabel(ch.label.slice(0, 100))
            .setValue(ch.url)
            .setDescription(`الفصل ${ch.number}`)
        )
      );

    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }

  console.log('[publish] عدد الـ rows:', rows.length, '| embed length:', JSON.stringify(embed.toJSON()).length);

  const msg = await channel.send({ embeds: [embed], components: rows });
  return msg.id;
}

// ─── معالجة Select Menu ───────────────────────────────────────

export async function handleMangaSelectMenu(
  interaction: StringSelectMenuInteraction,
  client: Client,
): Promise<void> {
  // customId: omg_select:{slug}:{offset}
  const parts      = interaction.customId.split(':');
  const slug       = parts[1];
  const chapterUrl = interaction.values[0];

  const manga = await getMangaDetails(slug).catch(() => null);
  const chapter = manga?.chapters.find(c => c.url === chapterUrl);
  const label   = chapter?.label ?? `فصل من ${slug}`;

  // نمرر قائمة روابط الفصول كاملة عشان يشتغل زر الفصل التالي/السابق
  const allChapterUrls = manga?.chapters.map(c => c.url) ?? [chapterUrl];

  await startOnlineReading(client, interaction, slug, chapterUrl, label, allChapterUrls);
}

export function getOnlineActiveSessions() {
  return Array.from(onlineSessions.values());
}
