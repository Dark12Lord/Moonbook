// ─── room.ts ─────────────────────────────────────────────────
// إنشاء وحذف غرف القراءة المؤقتة

import {
  Client,
  Guild,
  CategoryChannel,
  ChannelType,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import { slugify } from './utils';
import { logError } from './logger';

const CATEGORY_NAME =
  process.env.READING_CATEGORY_NAME || '📚 Moonbook Reading Rooms';

// ─── تأكد أن الـ Category موجودة أو أنشئها ───────────────────
async function ensureCategory(guild: Guild): Promise<CategoryChannel> {
  const existing = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildCategory && ch.name === CATEGORY_NAME
  ) as CategoryChannel | undefined;

  if (existing) return existing;

  return guild.channels.create({
    name: CATEGORY_NAME,
    type: ChannelType.GuildCategory,
  });
}

// ─── إنشاء روم القراءة ───────────────────────────────────────
export async function createReadingRoom(
  client: Client,
  guildId: string,
  userId: string,
  username: string,
  chapterSlug: string
): Promise<TextChannel> {
  const guild = await client.guilds.fetch(guildId);
  const category = await ensureCategory(guild);

  // اسم الروم: 📖・chapter-slug-username
  const safeName = `${chapterSlug}-${slugify(username)}`.slice(0, 90);
  const channelName = `📖・${safeName}`;

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      {
        // @everyone — ممنوع يشوف
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        // المستخدم — يشوف ويتفاعل
        id: userId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      {
        // البوت نفسه — كامل الصلاحيات
        id: client.user!.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
        ],
      },
    ],
  });

  return channel as TextChannel;
}

// ─── حذف روم القراءة ─────────────────────────────────────────
export async function deleteReadingRoom(
  client: Client,
  channelId: string
): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      await (channel as TextChannel).delete('Moonbook reading session ended');
    }
  } catch (err: any) {
    // لو الروم اتحذف يدوياً ما نوقف البوت
    if (err?.code !== 10003) {
      await logError({ context: 'deleteReadingRoom', message: err.message, stack: err.stack });
    }
  }
}
