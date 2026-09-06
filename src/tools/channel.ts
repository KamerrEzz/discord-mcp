import { ChannelType, type GuildBasedChannel, type NonThreadGuildBasedChannel } from 'discord.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CHANNEL_TYPE_LABELS,
  READ_ONLY_ANNOTATIONS,
  errorResult,
  formatTag,
  okResult,
  resolveChannel,
  resolveGuild,
  toFriendlyError,
  truncate,
  type ToolDeps,
} from './helpers.js';

const ChildChannelItemOutput = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  position: z.number(),
  topic: z.string().nullable().optional(),
  nsfw: z.boolean().optional(),
  slowmodeSeconds: z.number().optional(),
});
type ChildChannelItemOutput = z.infer<typeof ChildChannelItemOutput>;

const CategoryOutput = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number(),
  channels: z.array(ChildChannelItemOutput),
});
type CategoryOutput = z.infer<typeof CategoryOutput>;

const ListChannelsInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
  })
  .strict();

const ListChannelsOutput = z.object({
  guildId: z.string(),
  guildName: z.string(),
  categories: z.array(CategoryOutput),
  uncategorized: z.array(ChildChannelItemOutput),
  totalChannelCount: z.number(),
});
type ListChannelsOutput = z.infer<typeof ListChannelsOutput>;

const GetChannelInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    channelId: z.string().describe('The channel ID to inspect, e.g. "112233445566778899". Use discord_list_channels to find channel IDs.'),
  })
  .strict();

const GetChannelOutput = z.object({
  channelId: z.string(),
  name: z.string(),
  type: z.string(),
  parent: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable(),
  topic: z.string().nullable().optional(),
  nsfw: z.boolean().optional(),
  slowmodeSeconds: z.number().optional(),
  position: z.number(),
  botPermissions: z.record(z.string(), z.boolean()),
});
type GetChannelOutput = z.infer<typeof GetChannelOutput>;

const ListMessagesInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    channelId: z.string().describe('The text channel to read messages from, e.g. "112233445566778899".'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Number of recent messages to return, 1-100. Example: 25.'),
    before: z
      .string()
      .optional()
      .describe('Message ID to paginate before (older than). Pass the oldest message ID from a previous call to fetch the previous page. Example: "998877665544332211".'),
  })
  .strict();

const MessageItemOutput = z.object({
  id: z.string(),
  authorId: z.string(),
  authorDisplayName: z.string(),
  authorTag: z.string(),
  timestamp: z.string(),
  content: z.string(),
  truncated: z.boolean(),
  attachmentCount: z.number(),
  pinned: z.boolean(),
  replyToMessageId: z.string().nullable(),
});
type MessageItemOutput = z.infer<typeof MessageItemOutput>;

const ListMessagesOutput = z.object({
  guildId: z.string(),
  guildName: z.string(),
  channelId: z.string(),
  channelName: z.string(),
  messages: z.array(MessageItemOutput),
  count: z.number(),
});
type ListMessagesOutput = z.infer<typeof ListMessagesOutput>;

/** Permission names surfaced in discord_get_channel as the bot's snapshot. */
const BOT_PERMISSION_HIGHLIGHTS = [
  'ViewChannel',
  'SendMessages',
  'SendMessagesInThreads',
  'EmbedLinks',
  'AttachFiles',
  'ReadMessageHistory',
  'ManageMessages',
  'ManageChannels',
  'MentionEveryone',
  'AddReactions',
  'Connect',
  'Speak',
  'CreatePublicThreads',
  'ManageThreads',
] as const;

/**
 * Type predicates that avoid TypeScript's generic 'in' narrowing producing
 * unknown/{} on mixed-class unions (GuildBasedChannel includes ForumChannel,
 * ThreadChannel, VoiceChannel, etc., which confuses the built-in narrowing).
 */
function hasTopic(channel: GuildBasedChannel): channel is GuildBasedChannel & { topic: string | null } {
  return 'topic' in channel;
}
function hasNsfw(channel: GuildBasedChannel): channel is GuildBasedChannel & { nsfw: boolean } {
  return 'nsfw' in channel;
}
function hasSlowmode(channel: GuildBasedChannel): channel is GuildBasedChannel & { rateLimitPerUser: number | null } {
  return 'rateLimitPerUser' in channel;
}

/**
 * Builds the shared child-channel summary (used by list AND get tools).
 */
function toChildChannelItem(channel: NonThreadGuildBasedChannel): ChildChannelItemOutput {
  const item: ChildChannelItemOutput = {
    id: channel.id,
    name: channel.name,
    type: CHANNEL_TYPE_LABELS[channel.type] ?? String(channel.type),
    position: channel.position,
  };
  if (hasTopic(channel)) {
    item.topic = channel.topic ?? null;
  }
  if (hasNsfw(channel)) {
    item.nsfw = channel.nsfw;
  }
  if (hasSlowmode(channel)) {
    item.slowmodeSeconds = channel.rateLimitPerUser ?? 0;
  }
  return item;
}

function sortByPosition<T extends { position: number; name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

export function registerChannelTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'discord_list_channels',
    {
      title: 'List Guild Channels',
      description:
        'Returns the guild\'s channel hierarchy: categories (id, name, position) each with their child text/voice/forum/' +
        'announcement channels (id, name, type, position, topic, nsfw, slowmode), plus uncategorized channels at the end.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n\n' +
        'Returns:\n' +
        '  { "guildId", "guildName", "categories": [ { "id", "name", "position", "channels": [ { "id", "name", "type", "position", "topic"?, "nsfw"?, "slowmodeSeconds"? } ] } ], "uncategorized": [ ... ], "totalChannelCount" }\n\n' +
        'Examples:\n' +
        '  - "Where do people chat?" -> {} (uses GUILD_ID)\n' +
        '  - "List channels in 123456789012345678" -> {"guildId": "123456789012345678"}\n\n' +
        'Notes: threads are not listed (they belong to their parent channel); channels whose category is not visible to the bot appear under "uncategorized". ' +
        'Only channels the bot can view are returned.',
      inputSchema: ListChannelsInput,
      outputSchema: ListChannelsOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: z.infer<typeof ListChannelsInput>) => {
      try {
        const guild = await resolveGuild(deps, params.guildId);

        const channels = guild.channels.cache;
        const byId = new Map<string, ChildChannelItemOutput>();
        const parentIds = new Map<string, string | null>();

        for (const channel of channels.values()) {
          if (channel.type === ChannelType.GuildCategory || channel.isThread()) continue;
          byId.set(channel.id, toChildChannelItem(channel));
          parentIds.set(channel.id, channel.parentId ?? null);
        }

        const categories: CategoryOutput[] = [];
        for (const channel of channels.values()) {
          if (channel.type !== ChannelType.GuildCategory) continue;
          const children = sortByPosition(
            [...byId.values()].filter((child) => parentIds.get(child.id) === channel.id),
          );
          categories.push({ id: channel.id, name: channel.name, position: channel.position, channels: children });
        }
        const sortedCategories = sortByPosition(categories);

        const uncategorized = sortByPosition(
          [...byId.values()].filter((child) => parentIds.get(child.id) === null),
        );

        const structured: ListChannelsOutput = {
          guildId: guild.id,
          guildName: guild.name,
          categories: sortedCategories,
          uncategorized,
          totalChannelCount: byId.size,
        };

        const lines = [`# Channels in ${guild.name} (${byId.size} total)`, ''];
        for (const category of sortedCategories) {
          lines.push(`## ${category.name} (category)`);
          for (const child of category.channels) {
            lines.push(`  - ${child.name} (${child.type})${child.topic ? ` — ${truncate(child.topic, 80).text}` : ''}`);
          }
        }
        if (uncategorized.length > 0) {
          lines.push('## Uncategorized');
          for (const child of uncategorized) {
            lines.push(`  - ${child.name} (${child.type})`);
          }
        }

        return okResult(structured, lines.join('\n'));
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to list channels:'));
      }
    },
  );

  server.registerTool(
    'discord_get_channel',
    {
      title: 'Get Channel Info',
      description:
        'Returns full information about one channel: type, parent category (id + name), topic, slowmode, nsfw flag, ' +
        'position, and a snapshot of the bot\'s permissions on it.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - channelId (string, required): Channel ID, e.g. "112233445566778899".\n\n' +
        'Returns:\n' +
        '  { "channelId", "name", "type", "parent": { "id", "name" } | null, "topic"?, "nsfw"?, "slowmodeSeconds"?, "position", "botPermissions": Record<string, boolean> }\n\n' +
        'Examples:\n' +
        '  - "What is #announcements about?" -> {"channelId": "112233445566778899"}\n\n' +
        'Errors: "Channel not found" when the ID is wrong or the bot cannot view the channel.',
      inputSchema: GetChannelInput,
      outputSchema: GetChannelOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: z.infer<typeof GetChannelInput>) => {
      try {
        const guild = await resolveGuild(deps, params.guildId);
        const channel = resolveChannel(guild, params.channelId);

        if (channel.isThread()) {
          return errorResult(
            `Channel "${params.channelId}" is a thread inside "#${channel.parent?.name ?? 'unknown'}". ` +
              'Use discord_list_messages with the parent channel to read thread content. ' +
              'For channel metadata, use discord_list_channels on the parent channel.',
          );
        }

        const structured: GetChannelOutput = {
          channelId: channel.id,
          name: channel.name,
          type: CHANNEL_TYPE_LABELS[channel.type] ?? String(channel.type),
          parent: channel.parent
            ? { id: channel.parent.id, name: channel.parent.name }
            : null,
          position: channel.position,
          botPermissions: {},
        };

        if (hasTopic(channel)) structured.topic = channel.topic ?? null;
        if (hasNsfw(channel)) structured.nsfw = channel.nsfw;
        if (hasSlowmode(channel)) structured.slowmodeSeconds = channel.rateLimitPerUser ?? 0;

        const botUser = deps.client.user;
        if (botUser) {
          const perms = channel.permissionsFor(botUser);
          if (perms) {
            for (const permission of BOT_PERMISSION_HIGHLIGHTS) {
              structured.botPermissions[permission] = perms.has(permission);
            }
          }
        }

        const lines = [
          `# ${channel.name} (${channel.id})`,
          `Type: ${structured.type}`,
          `Parent: ${structured.parent ? `${structured.parent.name} (category)` : 'none'}`,
          ...(structured.topic !== undefined ? [`Topic: ${structured.topic ?? '(empty)'}`] : []),
          ...(structured.nsfw !== undefined ? [`NSFW: ${structured.nsfw}`] : []),
          ...(structured.slowmodeSeconds !== undefined ? [`Slowmode: ${structured.slowmodeSeconds}s`] : []),
          `Position: ${channel.position}`,
          `Bot permissions: ${Object.entries(structured.botPermissions)
            .filter(([, allowed]) => allowed)
            .map(([name]) => name)
            .join(', ') || 'none checked'}`,
        ];

        return okResult(structured, lines.join('\n'));
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to get the channel:'));
      }
    },
  );

  server.registerTool(
    'discord_list_messages',
    {
      title: 'List Recent Messages',
      description:
        'Returns recent messages from a channel (newest first): id, author display name + tag, timestamp, content ' +
        '(capped at 1000 chars), attachment count, pinned flag, and reply-to reference.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - channelId (string, required): Text channel ID, e.g. "112233445566778899".\n' +
        '  - limit (number, optional): How many messages to return, 1-100 (default: 25). Example: 50.\n' +
        '  - before (string, optional): Message ID to paginate before (older than). Example: "998877665544332211".\n\n' +
        'Returns:\n' +
        '  { "guildId", "guildName", "channelId", "channelName", "messages": [ { "id", "authorId", "authorDisplayName", "authorTag", "timestamp", "content", "truncated", "attachmentCount", "pinned", "replyToMessageId" } ], "count" }\n\n' +
        'Examples:\n' +
        '  - "What was the last thing said in #general?" -> {"channelId": "112233445566778899", "limit": 10}\n' +
        '  - "Show older messages" -> {"channelId": "112233445566778899", "limit": 25, "before": "<oldest id from previous call>"}\n\n' +
        'Errors: "Channel not found" for bad IDs; "not a text channel" for voice/category channels; missing permission hints when the bot lacks Read Message History.',
      inputSchema: ListMessagesInput,
      outputSchema: ListMessagesOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: z.infer<typeof ListMessagesInput>) => {
      try {
        const guild = await resolveGuild(deps, params.guildId);
        const channel = resolveChannel(guild, params.channelId);

        if (!channel.isTextBased()) {
          return errorResult(
            `Channel "${params.channelId}" (${channel.name}) is not a text channel (type: ${CHANNEL_TYPE_LABELS[channel.type] ?? channel.type}). ` +
              'Only text-based channels have messages. Use discord_list_channels to find a text channel.',
          );
        }

        const fetched = await channel.messages.fetch({
          limit: params.limit,
          ...(params.before ? { before: params.before } : {}),
        });

        const messages: MessageItemOutput[] = fetched.map((message) => {
          const content = truncate(message.content, 1000);
          return {
            id: message.id,
            authorId: message.author.id,
            authorDisplayName: message.member?.displayName ?? message.author.username,
            authorTag: formatTag(message.author),
            timestamp: message.createdAt.toISOString(),
            content: content.text,
            truncated: content.truncated,
            attachmentCount: message.attachments.size,
            pinned: message.pinned,
            replyToMessageId: message.reference?.messageId ?? null,
          };
        });

        const structured: ListMessagesOutput = {
          guildId: guild.id,
          guildName: guild.name,
          channelId: channel.id,
          channelName: channel.name,
          messages,
          count: messages.length,
        };

        const lines = [
          `# Recent messages in #${channel.name} (${messages.length})`,
          '',
          ...messages.map((message, index) => {
            const preview = truncate(message.content, 120).text || '(no text content)';
            const replyNote = message.replyToMessageId ? ' [reply]' : '';
            const attachmentNote = message.attachmentCount > 0 ? ` [${message.attachmentCount} attachment(s)]` : '';
            const pinnedNote = message.pinned ? ' [PINNED]' : '';
            return `${index + 1}. ${message.authorDisplayName} (${message.authorTag}) · ${message.timestamp}${replyNote}${attachmentNote}${pinnedNote}\n   ${preview}`;
          }),
        ];

        return okResult(structured, lines.join('\n'));
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to list messages:'));
      }
    },
  );
}