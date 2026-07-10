// ─── commands.ts ─────────────────────────────────────────────

import {
  Client,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';

import { isAdmin, buildProgressBar } from './utils';
import { listChapters, deleteChapter } from './upload';
import { getActiveSessions, publishChapterById } from './reader';
import { logChapterDeleted, logChapterPublished, logError } from './logger';

// ─── تعريف الأوامر ────────────────────────────────────────────
export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('moonbook')
    .setDescription('Moonbook — قارئ المانهوا')
    .addSubcommand((sub) =>
      sub.setName('read').setDescription('اعرض الفصول المتاحة وابدأ القراءة')
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('(أدمن) قائمة جميع الفصول مع معلومات إضافية')
    )
    .addSubcommand((sub) =>
      sub
        .setName('publish')
        .setDescription('(أدمن) نشر فصل في قناة المكتبة')
        .addStringOption((opt) =>
          opt.setName('chapter').setDescription('ID الفصل').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('(أدمن) حذف فصل')
        .addStringOption((opt) =>
          opt.setName('chapter').setDescription('ID الفصل').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('stats').setDescription('(أدمن) إحصائيات البوت')
    )
    .addSubcommand((sub) =>
      sub.setName('rooms').setDescription('(أدمن) غرف القراءة المفتوحة حالياً')
    )
    .toJSON(),
];

// ─── تسجيل الأوامر مع Discord ────────────────────────────────
export async function registerCommands(client: Client): Promise<void> {
  const token = process.env.DISCORD_TOKEN || '';
  const guildId = process.env.DISCORD_GUILD_ID || '';

  if (!token || !guildId) {
    console.warn('[commands] DISCORD_TOKEN or DISCORD_GUILD_ID missing, skipping registration.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user!.id, guildId),
      { body: commandDefinitions }
    );
    console.log('[commands] Slash commands registered.');
  } catch (err: any) {
    await logError({ context: 'registerCommands', message: err.message, stack: err.stack });
    console.error('[commands] Failed to register commands:', err);
  }
}

// ─── معالجة الأوامر ───────────────────────────────────────────
export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (interaction.commandName !== 'moonbook') return;

  const sub = interaction.options.getSubcommand();

  // ─── /moonbook read — متاح للجميع ────────────────────────
  if (sub === 'read') {
    await interaction.deferReply({ ephemeral: true });
    const chapters = await listChapters();

    if (!chapters.length) {
      await interaction.editReply('📭 لا يوجد فصول متاحة حالياً.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('📚 الفصول المتاحة')
      .setColor(0x7c5cff)
      .setDescription(
        chapters
          .map((ch, i) => `**${i + 1}.** ${ch.title}\n> 🖼️ ${ch.images.length} صفحة`)
          .join('\n\n')
      )
      .setFooter({ text: 'اذهب لقناة المكتبة واضغط "ابدأ القراءة"' });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ─── باقي الأوامر للأدمن فقط ─────────────────────────────
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({
      content: '❌ ليس لديك صلاحية لاستخدام هذا الأمر.',
      ephemeral: true,
    });
    return;
  }

  // ─── /moonbook list ───────────────────────────────────────
  if (sub === 'list') {
    await interaction.deferReply({ ephemeral: true });
    const chapters = await listChapters();

    if (!chapters.length) {
      await interaction.editReply('📭 لا يوجد فصول حالياً.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('📚 قائمة الفصول')
      .setColor(0x7c5cff)
      .setDescription(
        chapters
          .map((ch, i) => `**${i + 1}.** ${ch.title}\n\`${ch.id}\` • ${ch.images.length} صفحة`)
          .join('\n\n')
      )
      .setFooter({ text: `${chapters.length} فصل إجمالاً` });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ─── /moonbook publish ────────────────────────────────────
  if (sub === 'publish') {
    await interaction.deferReply({ ephemeral: true });
    const chapterId = interaction.options.getString('chapter', true);

    try {
      await publishChapterById(
        interaction.client,
        chapterId,
        interaction.user.username
      );

      const chapters = await listChapters();
      const chapter = chapters.find((ch) => ch.id === chapterId);

      await logChapterPublished({
        title: chapter?.title ?? chapterId,
        pages: chapter?.images.length ?? 0,
        publishedBy: interaction.user.username,
      });

      await interaction.editReply(`✅ تم نشر **${chapter?.title ?? chapterId}** في المكتبة.`);
    } catch (err: any) {
      await logError({ context: 'publish command', message: err.message, stack: err.stack });
      await interaction.editReply(`❌ فشل النشر: ${err.message}`);
    }
    return;
  }

  // ─── /moonbook delete ─────────────────────────────────────
  if (sub === 'delete') {
    await interaction.deferReply({ ephemeral: true });
    const chapterId = interaction.options.getString('chapter', true);

    try {
      const chapters = await listChapters();
      const chapter = chapters.find((ch) => ch.id === chapterId);

      await deleteChapter(chapterId);

      await logChapterDeleted({
        title: chapter?.title ?? chapterId,
        deletedBy: interaction.user.username,
      });

      await interaction.editReply(`🗑️ تم حذف **${chapter?.title ?? chapterId}**.`);
    } catch (err: any) {
      await logError({ context: 'delete command', message: err.message, stack: err.stack });
      await interaction.editReply(`❌ فشل الحذف: ${err.message}`);
    }
    return;
  }

  // ─── /moonbook stats ──────────────────────────────────────
  if (sub === 'stats') {
    await interaction.deferReply({ ephemeral: true });

    const chapters = await listChapters();
    const activeSessions = getActiveSessions();
    const totalPages = chapters.reduce((sum, ch) => sum + ch.images.length, 0);

    const embed = new EmbedBuilder()
      .setTitle('📊 إحصائيات Moonbook')
      .setColor(0x7c5cff)
      .addFields(
        { name: '📚 الفصول',          value: String(chapters.length),      inline: true },
        { name: '🖼️ إجمالي الصفحات', value: String(totalPages),           inline: true },
        { name: '📖 غرف مفتوحة',      value: String(activeSessions.length), inline: true }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ─── /moonbook rooms ──────────────────────────────────────
  if (sub === 'rooms') {
    await interaction.deferReply({ ephemeral: true });

    const activeSessions = getActiveSessions();

    if (!activeSessions.length) {
      await interaction.editReply('📭 لا توجد غرف قراءة مفتوحة حالياً.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('📖 غرف القراءة المفتوحة')
      .setColor(0x7c5cff)
      .setDescription(
        activeSessions
          .map((s) => {
            const durationMin = Math.round((Date.now() - s.openedAt) / 60000);
            return `**${s.username}** — ${s.title}\nالصفحة ${s.pageIndex + 1} • منذ ${durationMin} دقيقة`;
          })
          .join('\n\n')
      )
      .setFooter({ text: `${activeSessions.length} غرفة نشطة` });

    await interaction.editReply({ embeds: [embed] });
    return;
  }
}
