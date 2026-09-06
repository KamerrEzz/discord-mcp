import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CHANNEL_TYPE_LABELS, READ_ONLY_ANNOTATIONS, errorResult, okResult, resolveGuild, toFriendlyError, type ToolDeps } from './helpers.js';

const GuildSummaryInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID to inspect, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
  })
  .strict();

const GuildSummaryOutput = z.object({
  guildId: z.string(),
  name: z.string(),
  iconUrl: z.string().nullable(),
  description: z.string().nullable(),
  ownerId: z.string(),
  memberCount: z.number(),
  approximateOnlineCount: z.number().nullable(),
  channelCounts: z.record(z.string(), z.number()),
  roleCount: z.number(),
  emojiCount: z.number(),
  stickerCount: z.number(),
  boostTier: z.number(),
  boostCount: z.number().nullable(),
  createdAt: z.string(),
});

export function registerGuildTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'discord_get_guild_summary',
    {
      title: 'Get Guild Summary',
      description:
        'Returns an overview of a Discord guild (server): name, icon URL, member count, approximate online count, ' +
        'channel counts grouped by type (text, voice, forum, category, ...), role count, emoji/sticker counts, and boost level/count.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n\n' +
        'Returns:\n' +
        '  {\n' +
        '    "guildId": string, "name": string, "iconUrl": string|null, "description": string|null,\n' +
        '    "memberCount": number, "approximateOnlineCount": number|null, "channelCounts": Record<string, number>,\n' +
        '    "roleCount": number, "emojiCount": number, "stickerCount": number, "boostTier": number, "boostCount": number\n' +
        '  }\n\n' +
        'Examples:\n' +
        '  - "What is the Zeew Space server about?" -> no args (uses GUILD_ID)\n' +
        '  - "Summarize guild 987654321098765432" -> {"guildId": "987654321098765432"}\n\n' +
        'Note: approximateOnlineCount is Discord\'s server-provided approximation; it is null when unavailable. ' +
        'Live presence counts are not provided because this bot does not enable the GuildPresences intent.',
      inputSchema: GuildSummaryInput,
      outputSchema: GuildSummaryOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: z.infer<typeof GuildSummaryInput>) => {
      try {
        const guild = await resolveGuild(deps, params.guildId);

        const channelCounts: Record<string, number> = {};
        for (const channel of guild.channels.cache.values()) {
          const label = CHANNEL_TYPE_LABELS[channel.type] ?? String(channel.type);
          channelCounts[label] = (channelCounts[label] ?? 0) + 1;
        }

        const structured: z.infer<typeof GuildSummaryOutput> = {
          guildId: guild.id,
          name: guild.name,
          iconUrl: guild.iconURL({ size: 256 }),
          description: guild.description,
          ownerId: guild.ownerId,
          memberCount: guild.memberCount,
          approximateOnlineCount: guild.approximatePresenceCount,
          channelCounts,
          roleCount: guild.roles.cache.size,
          emojiCount: guild.emojis.cache.size,
          stickerCount: guild.stickers.cache.size,
          boostTier: guild.premiumTier,
          boostCount: guild.premiumSubscriptionCount,
          createdAt: guild.createdAt.toISOString(),
        };

        const channelSummary = Object.entries(channelCounts)
          .map(([type, count]) => `${type}: ${count}`)
          .join(', ');

        const text = [
          `# ${guild.name} (${guild.id})`,
          `Members: ${guild.memberCount}` +
            (guild.approximatePresenceCount !== null ? ` · ~${guild.approximatePresenceCount} online` : ' · online count unavailable'),
          `Boost tier ${guild.premiumTier} · ${guild.premiumSubscriptionCount ?? 0} boosts`,
          `Roles: ${guild.roles.cache.size} · Emojis: ${guild.emojis.cache.size} · Stickers: ${guild.stickers.cache.size}`,
          `Channels: ${channelSummary || 'none visible'}`,
          `Created: ${guild.createdAt.toISOString()}`,
        ].join('\n');

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to get the guild summary:'));
      }
    },
  );
}