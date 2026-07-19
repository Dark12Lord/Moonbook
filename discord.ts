// ─── discord.ts ───────────────────────────────────────────────

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import {
  handleReaderInteraction,
  handleGotoModal,
  handleStartReading,
} from './reader';
import { handleSlashCommand, registerCommands } from './commands';
import { handleOnlineReaderButton, handleOnlineGotoModal, handleMangaSelectMenu } from './manga_reader';
import { logError } from './logger';

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel, Partials.Message],
  });
}

export async function startDiscordBot(client: Client): Promise<void> {
  const token = process.env.DISCORD_TOKEN || '';

  if (!token) {
    console.log('[discord] DISCORD_TOKEN is missing, bot will stay offline.');
    return;
  }

  client.on('ready', async () => {
    console.log(`[discord] Logged in as ${client.user?.tag}`);
    await registerCommands(client);
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      // ─── Slash Commands ───────────────────────────────────
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction);
        return;
      }

      // ─── Modal Submit ─────────────────────────────────────
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('moonbook_modal:')) {
          await handleGotoModal(interaction);
        } else if (interaction.customId.startsWith('omg_modal:')) {
          await handleOnlineGotoModal(interaction);
        }
        return;
      }

      // ─── Select Menu (اختيار فصل من المانهوا) ─────────────
      if (interaction.isStringSelectMenu()) {
        if (interaction.customId.startsWith('omg_select:')) {
          await handleMangaSelectMenu(interaction, client);
        }
        return;
      }

      // ─── Buttons ──────────────────────────────────────────
      if (!interaction.isButton()) return;

      // زر "ابدأ القراءة" في بطاقة الفصل المرفوع
      if (interaction.customId.startsWith('moonbook_start:')) {
        await handleStartReading(interaction);
        return;
      }

      // أزرار قارئ الملفات المرفوعة
      if (interaction.customId.startsWith('moonbook_')) {
        await handleReaderInteraction(interaction);
        return;
      }

      // أزرار قارئ المانهوا الأونلاين
      if (interaction.customId.startsWith('omg_')) {
        await handleOnlineReaderButton(interaction);
        return;
      }

    } catch (error: any) {
      console.error('[discord] interaction error:', error);

      await logError({
        context: 'interactionCreate',
        message: error.message,
        stack: error.stack,
      });

      if (interaction.isRepliable()) {
        const alreadyReplied = interaction.replied || interaction.deferred;
        if (!alreadyReplied) {
          await interaction.reply({
            content: '❌ حدث خطأ غير متوقع.',
            ephemeral: true,
          });
        }
      }
    }
  });

  await client.login(token);
}
