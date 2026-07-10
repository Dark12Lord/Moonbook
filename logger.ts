// ─── logger.ts ───────────────────────────────────────────────
// كل الـ logs ترسل كـ Discord Embed لـ Webhook خارجي

const WEBHOOK_URL = process.env.LOG_WEBHOOK_URL || '';

type LogLevel = 'info' | 'success' | 'warning' | 'error';

const COLORS: Record<LogLevel, number> = {
  info:    0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  error:   0xed4245,
};

const ICONS: Record<LogLevel, string> = {
  info:    'ℹ️',
  success: '✅',
  warning: '⚠️',
  error:   '❌',
};

interface LogField {
  name: string;
  value: string;
  inline?: boolean;
}

interface LogOptions {
  level?: LogLevel;
  title: string;
  description?: string;
  fields?: LogField[];
}

async function sendLog(options: LogOptions): Promise<void> {
  if (!WEBHOOK_URL) return;

  const { level = 'info', title, description, fields } = options;

  const embed: Record<string, any> = {
    title: `${ICONS[level]} ${title}`,
    color: COLORS[level],
    timestamp: new Date().toISOString(),
    footer: { text: 'Moonbook Logger' },
  };

  if (description) embed.description = description;
  if (fields?.length) embed.fields = fields;

  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err) {
    console.error('[logger] Failed to send webhook log:', err);
  }
}

// ─── دوال مخصصة لكل حدث ──────────────────────────────────────

export async function logChapterUploaded(info: {
  title: string;
  pages: number;
  fileName: string;
  sizeMb: string;
  skippedJunk?: number;
}) {
  const fields = [
    { name: '📖 الفصل',     value: info.title,          inline: true },
    { name: '🖼️ الصفحات',  value: String(info.pages),  inline: true },
    { name: '📁 الملف',     value: info.fileName,       inline: true },
    { name: '💾 الحجم',     value: `${info.sizeMb} MB`, inline: true },
  ];

  if (info.skippedJunk && info.skippedJunk > 0) {
    fields.push({
      name: '🗑️ صور مستبعدة تلقائياً',
      value: String(info.skippedJunk),
      inline: true,
    });
  }

  await sendLog({
    level: 'success',
    title: 'فصل جديد رُفع',
    fields,
  });
}

export async function logChapterPublished(info: {
  title: string;
  pages: number;
  publishedBy: string;
}) {
  await sendLog({
    level: 'info',
    title: 'فصل نُشر في المكتبة',
    fields: [
      { name: '📖 الفصل',       value: info.title,          inline: true },
      { name: '🖼️ الصفحات',    value: String(info.pages),  inline: true },
      { name: '👤 نُشر بواسطة', value: info.publishedBy,    inline: true },
    ],
  });
}

export async function logRoomOpened(info: {
  username: string;
  userId: string;
  chapterTitle: string;
  channelName: string;
}) {
  await sendLog({
    level: 'info',
    title: 'غرفة قراءة فُتحت',
    fields: [
      { name: '👤 المستخدم', value: `${info.username} (${info.userId})`, inline: true },
      { name: '📖 الفصل',   value: info.chapterTitle,  inline: true },
      { name: '🏠 الروم',   value: info.channelName,   inline: true },
    ],
  });
}

export async function logRoomClosed(info: {
  username: string;
  userId: string;
  chapterTitle: string;
  pagesRead: number;
  durationMin: number;
}) {
  await sendLog({
    level: 'success',
    title: 'غرفة قراءة أُغلقت',
    fields: [
      { name: '👤 المستخدم',    value: `${info.username} (${info.userId})`, inline: true },
      { name: '📖 الفصل',      value: info.chapterTitle,       inline: true },
      { name: '📄 صفحات قرأها', value: String(info.pagesRead), inline: true },
      { name: '⏱️ المدة',       value: `${info.durationMin} دقيقة`, inline: true },
    ],
  });
}

export async function logChapterDeleted(info: {
  title: string;
  deletedBy: string;
}) {
  await sendLog({
    level: 'warning',
    title: 'فصل حُذف',
    fields: [
      { name: '📖 الفصل',       value: info.title,      inline: true },
      { name: '🗑️ حُذف بواسطة', value: info.deletedBy,  inline: true },
    ],
  });
}

export async function logError(info: {
  context: string;
  message: string;
  stack?: string;
}) {
  await sendLog({
    level: 'error',
    title: `خطأ — ${info.context}`,
    description: `\`\`\`\n${info.message}\n${info.stack ?? ''}\n\`\`\``.slice(0, 4000),
  });
}
