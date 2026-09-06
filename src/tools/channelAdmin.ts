import {
  ChannelType,
  type CategoryChannel,
  type Guild,
  type GuildChannel,
  type GuildChannelCreateOptions,
  type GuildChannelEditOptions,
  type GuildChannelTypes,
} from 'discord.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CHANNEL_TYPE_LABELS,
  DESTRUCTIVE_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  errorResult,
  okResult,
  requireConfirm,
  resolveChannel,
  resolveGuild,
  toFriendlyError,
  type ToolDeps,
} from './helpers.js';

/**
 * Type predicates that avoid TypeScript's generic 'in' narrowing producing
 * unknown/{} on mixed-class unions (same pattern as channel.ts). They accept the
 * abstract GuildChannel — the type GuildChannelManager.edit() returns.
 */
function hasTopic(channel: GuildChannel): channel is GuildChannel & { topic: string | null } {
  return 'topic' in channel;
}
function hasNsfw(channel: GuildChannel): channel is GuildChannel & { nsfw: boolean } {
  return 'nsfw' in channel;
}
function hasSlowmode(channel: GuildChannel): channel is GuildChannel & { rateLimitPerUser: number | null } {
  return 'rateLimitPerUser' in channel;
}

const CHANNEL_TYPE_BY_LABEL: Record<string, GuildChannelTypes> = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  category: ChannelType.GuildCategory,
};

const ConfirmTrue = z.boolean().describe('Human confirmation. Set to true only after the human approves.');
const ConfirmYes = z
  .literal('YES')
  .describe('Destructive confirmation. Requires the exact string "YES" after the human approves.');

const CreateChannelInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    name: z.string().min(1).max(100).describe('Channel name, 1-100 chars (lowercase, no spaces in Discord\'s display name). Example: "community-chat".'),
    type: z
      .enum(['text', 'voice', 'announcement', 'forum', 'category'])
      .optional()
      .describe('Channel type. Defaults to "text". Text channels support topics; categories are top-level containers.'),
    parentCategoryId: z
      .string()
      .optional()
      .describe('Category ID to create the channel under. REQUIRED unless type is "category". Use discord_list_channels to find category IDs. Example: "998877665544332211".'),
    topic: z.string().max(1024).optional().describe('Channel topic, max 1024 chars (forums/media allow 4096; 1024 is always safe). Example: "Community discussion".'),
    nsfw: z.boolean().optional().describe('Age-restrict the channel. Example: false.'),
    confirm: ConfirmTrue,
  })
  .strict();

const CreateChannelOutput = z.object({
  channelId: z.string(),
  guildId: z.string(),
  name: z.string(),
  type: z.string(),
  parentCategoryId: z.string().nullable(),
});
type CreateChannelOutput = z.infer<typeof CreateChannelOutput>;

const UpdateChannelInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    channelId: z.string().describe('The channel ID to update, e.g. "112233445566778899". Use discord_list_channels to find channel IDs.'),
    name: z.string().min(1).max(100).optional().describe('New channel name, 1-100 chars. Example: "events-chat".'),
    topic: z.string().max(1024).optional().describe('New topic, max 1024 chars (always within Discord\'s per-type limit). Example: "Weekly events and meetups".'),
    nsfw: z.boolean().optional().describe('Age-restrict the channel. Example: true.'),
    slowmodeSeconds: z
      .number()
      .int()
      .min(0)
      .max(21600)
      .optional()
      .describe('Slowmode: seconds a user must wait between messages, 0-21600. Example: 30.'),
    parentCategoryId: z
      .union([z.string(), z.null()])
      .optional()
      .describe('Category ID to move the channel under, or null to leave it uncategorized. Must resolve to a category channel. Example: "998877665544332211".'),
    confirm: ConfirmTrue,
  })
  .strict();

const UpdateChannelOutput = z.object({
  channelId: z.string(),
  guildId: z.string(),
  name: z.string(),
  type: z.string(),
  parentCategoryId: z.string().nullable(),
  position: z.number(),
  topic: z.string().nullable().optional(),
  nsfw: z.boolean().optional(),
  slowmodeSeconds: z.number().optional(),
});
type UpdateChannelOutput = z.infer<typeof UpdateChannelOutput>;

const DeleteChannelInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    channelId: z.string().describe('The channel ID to delete, e.g. "112233445566778899". Use discord_list_channels to find channel IDs.'),
    confirm: ConfirmYes,
  })
  .strict();

const DeleteChannelOutput = z.object({
  deletedChannelId: z.string(),
});
type DeleteChannelOutput = z.infer<typeof DeleteChannelOutput>;

const MoveChannelInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    channelId: z.string().describe('The channel ID to move, e.g. "112233445566778899". Use discord_list_channels to find channel IDs.'),
    targetCategoryId: z
      .union([z.string(), z.null()])
      .describe('Category ID to move the channel under, or null to uncategorize it. Must resolve to a category channel. Example: "998877665544332211" or null.'),
    position: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('0-based position within the target category among channels of the same type (0 = first). Omit to keep the current order. Example: 2.'),
    confirm: ConfirmTrue,
  })
  .strict();

const MoveChannelOutput = z.object({
  channelId: z.string(),
  parentCategoryId: z.string().nullable(),
  position: z.number(),
});
type MoveChannelOutput = z.infer<typeof MoveChannelOutput>;

function resolveCategory(guild: Guild, categoryId: string): CategoryChannel {
  const channel = guild.channels.cache.get(categoryId);
  if (!channel || channel.type !== ChannelType.GuildCategory) {
    throw new Error(
      `"${categoryId}" is not a category channel in guild "${guild.name}". ` +
        'Use discord_list_channels to find valid category IDs.',
    );
  }
  return channel;
}

function typeLabel(channel: GuildChannel): string {
  return CHANNEL_TYPE_LABELS[channel.type] ?? String(channel.type);
}

export function registerChannelAdminTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'discord_create_channel',
    {
      title: 'Create Guild Channel',
      description:
        'Creates a text, voice, announcement, forum, or category channel. Non-category channels must be created ' +
        'under a category (parentCategoryId is required). Requires the bot to have "Manage Channels".\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - name (string, required, 1-100): Channel name. Example: "community-chat".\n' +
        '  - type (string, optional): "text" (default), "voice", "announcement", "forum", or "category".\n' +
        '  - parentCategoryId (string, required unless type is "category"): Category ID to create the channel under.\n' +
        '  - topic (string, optional, max 1024): Supported for text/announcement/forum; rejected for voice and category.\n' +
        '  - nsfw (boolean, optional): Supported for text/voice/announcement/forum; rejected for category.\n' +
        '  - confirm (boolean, required): Human confirmation — set to true only after the human approves.\n\n' +
        'Returns:\n' +
        '  { "channelId", "guildId", "name", "type", "parentCategoryId" }\n\n' +
        'Examples:\n' +
        '  - "Create #community-chat under the Community category" -> {"name": "community-chat", "parentCategoryId": "998877665544332211", "topic": "Community discussion", "confirm": true}\n' +
        '  - "Create a new category called Staff" -> {"name": "Staff", "type": "category", "confirm": true}\n\n' +
        'Errors: "Missing Permissions" without Manage Channels; "not a category channel" for bad parent IDs; topic/nsfw rejected on unsupported types.',
      inputSchema: CreateChannelInput,
      outputSchema: CreateChannelOutput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (params: z.infer<typeof CreateChannelInput>) => {
      try {
        const gateError = requireConfirm(params, 'normal', 'discord_create_channel');
        if (gateError) return gateError;

        const guild = await resolveGuild(deps, params.guildId);
        const requestedType = params.type ?? 'text';

        let created: GuildChannel;
        if (requestedType === 'category') {
          if (params.parentCategoryId) {
            return errorResult('type "category" creates a TOP-LEVEL channel — parentCategoryId must not be set.');
          }
          if (params.topic !== undefined || params.nsfw !== undefined) {
            return errorResult('Category channels do not support a topic or an nsfw flag.');
          }
          created = await guild.channels.create({ name: params.name, type: ChannelType.GuildCategory });
        } else {
          if (!params.parentCategoryId) {
            return errorResult(
              'parentCategoryId is required when type is not "category". ' +
                'Use discord_list_channels to find the category ID to create the channel under.',
            );
          }
          const parent = resolveCategory(guild, params.parentCategoryId);
          const options: GuildChannelCreateOptions = {
            name: params.name,
            type: CHANNEL_TYPE_BY_LABEL[requestedType],
            parent,
          };
          if (params.topic !== undefined) {
            if (requestedType === 'voice') {
              return errorResult('Voice channels do not support a topic.');
            }
            options.topic = params.topic;
          }
          if (params.nsfw !== undefined) {
            options.nsfw = params.nsfw;
          }
          created = await guild.channels.create(options);
        }

        const structured: CreateChannelOutput = {
          channelId: created.id,
          guildId: guild.id,
          name: created.name,
          type: requestedType,
          parentCategoryId: created.parentId,
        };

        const text = [
          `${requestedType} channel "${created.name}" created in ${guild.name}.`,
          `  Channel ID: ${created.id}`,
          `  Category: ${created.parentId ?? 'none'}`,
        ].join('\n');

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to create the channel:'));
      }
    },
  );

  server.registerTool(
    'discord_update_channel',
    {
      title: 'Update Guild Channel',
      description:
        'Updates a channel\'s name, topic, nsfw flag, slowmode, and/or parent category. Only the fields you pass ' +
        'change; every field is optional but at least one must be provided. Requires the bot to have "Manage Channels".\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - channelId (string, required): Channel ID to update. Example: "112233445566778899".\n' +
        '  - name (string, optional, 1-100): New channel name. Example: "events-chat".\n' +
        '  - topic (string, optional, max 1024): New topic (only for channels that support topics).\n' +
        '  - nsfw (boolean, optional): Age-restrict the channel (only for channels that support the flag).\n' +
        '  - slowmodeSeconds (number, optional, 0-21600): Message slowmode (only for text/voice/stage/forum/media channels).\n' +
        '  - parentCategoryId (string or null, optional): Category ID to move the channel under, or null to uncategorize it.\n' +
        '  - confirm (boolean, required): Human confirmation — set to true only after the human approves.\n\n' +
        'Returns:\n' +
        '  { "channelId", "guildId", "name", "type", "parentCategoryId", "position", "topic"?, "nsfw"?, "slowmodeSeconds"? } — current values after the update\n\n' +
        'Examples:\n' +
        '  - "Rename #general to #community" -> {"channelId": "112233445566778899", "name": "community", "confirm": true}\n' +
        '  - "Put #announcements under the News category" -> {"channelId": "112233445566778899", "parentCategoryId": "998877665544332211", "confirm": true}\n\n' +
        'Errors: "Channel not found" for bad IDs; topic/nsfw/slowmode rejected on channel types that do not support them; categories cannot be moved under another category.',
      inputSchema: UpdateChannelInput,
      outputSchema: UpdateChannelOutput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (params: z.infer<typeof UpdateChannelInput>) => {
      try {
        const gateError = requireConfirm(params, 'normal', 'discord_update_channel');
        if (gateError) return gateError;

        const guild = await resolveGuild(deps, params.guildId);
        const channel = resolveChannel(guild, params.channelId);

        if (channel.isThread()) {
          return errorResult(
            `Channel "${params.channelId}" is a thread — this tool manages guild channels. ` +
              'Use discord_list_channels to find the parent channel.',
          );
        }

        const options: GuildChannelEditOptions = {};
        if (params.name !== undefined) options.name = params.name;
        if (params.topic !== undefined) {
          if (!hasTopic(channel)) {
            return errorResult(
              `Channel "${params.channelId}" (${channel.name}, type ${typeLabel(channel)}) does not support a topic.`,
            );
          }
          options.topic = params.topic;
        }
        if (params.nsfw !== undefined) {
          if (!hasNsfw(channel)) {
            return errorResult(
              `Channel "${params.channelId}" (${channel.name}, type ${typeLabel(channel)}) does not support an nsfw flag.`,
            );
          }
          options.nsfw = params.nsfw;
        }
        if (params.slowmodeSeconds !== undefined) {
          if (!hasSlowmode(channel)) {
            return errorResult(
              `Channel "${params.channelId}" (${channel.name}, type ${typeLabel(channel)}) does not support slowmode.`,
            );
          }
          options.rateLimitPerUser = params.slowmodeSeconds;
        }
        if (params.parentCategoryId !== undefined) {
          if (channel.type === ChannelType.GuildCategory) {
            return errorResult('A category channel cannot be moved under another category.');
          }
          options.parent = params.parentCategoryId === null ? null : resolveCategory(guild, params.parentCategoryId);
        }
        if (Object.keys(options).length === 0) {
          return errorResult(
            'No fields to update — provide at least one of name, topic, nsfw, slowmodeSeconds, or parentCategoryId.',
          );
        }

        const updated = await guild.channels.edit(channel, options);

        const structured: UpdateChannelOutput = {
          channelId: updated.id,
          guildId: guild.id,
          name: updated.name,
          type: typeLabel(updated),
          parentCategoryId: updated.parentId,
          position: updated.position,
        };
        if (hasTopic(updated)) structured.topic = updated.topic ?? null;
        if (hasNsfw(updated)) structured.nsfw = updated.nsfw;
        if (hasSlowmode(updated)) structured.slowmodeSeconds = updated.rateLimitPerUser ?? 0;

        const lines = [
          `Channel "${updated.name}" updated in ${guild.name}.`,
          `  Channel ID: ${updated.id}`,
          `  Type: ${structured.type}`,
          `  Parent: ${structured.parentCategoryId ?? 'none'}`,
          `  Position: ${updated.position}`,
        ];
        if (structured.topic !== undefined) lines.push(`  Topic: ${structured.topic ?? '(empty)'}`);
        if (structured.nsfw !== undefined) lines.push(`  NSFW: ${structured.nsfw}`);
        if (structured.slowmodeSeconds !== undefined) lines.push(`  Slowmode: ${structured.slowmodeSeconds}s`);

        return okResult(structured, lines.join('\n'));
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to update the channel:'));
      }
    },
  );

  server.registerTool(
    'discord_delete_channel',
    {
      title: 'Delete Guild Channel',
      description:
        'Permanently deletes a channel.\n\n' +
        'WARNING — destructive (requires confirm: "YES"): deleting a channel cannot be undone. ' +
        'Verified Discord API behavior for categories: deleting a CATEGORY does NOT delete its child channels — ' +
        'the children survive and become uncategorized (their parent_id is removed and Discord fires a Channel Update for each). ' +
        'Deleting any other channel permanently destroys it and all its messages. In Community guilds, the Rules/Guidelines ' +
        'and Community Updates channels cannot be deleted (the API rejects the request).\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - channelId (string, required): Channel ID to delete. Example: "112233445566778899".\n' +
        '  - confirm (string, required): Must be the exact string "YES" after the human approves.\n\n' +
        'Returns:\n' +
        '  { "deletedChannelId" }\n\n' +
        'Examples:\n' +
        '  - "Delete #old-events" -> {"channelId": "112233445566778899", "confirm": "YES"}\n' +
        '  - "Delete the Test category (children survive, uncategorized)" -> {"channelId": "998877665544332211", "confirm": "YES"}\n\n' +
        'Errors: "Channel not found" for bad IDs; threads cannot be deleted (archive them instead); "Missing Permissions" without Manage Channels; protected channels in Community guilds are rejected by Discord.',
      inputSchema: DeleteChannelInput,
      outputSchema: DeleteChannelOutput,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (params: z.infer<typeof DeleteChannelInput>) => {
      try {
        const gateError = requireConfirm(params, 'hard', 'discord_delete_channel');
        if (gateError) return gateError;

        const guild = await resolveGuild(deps, params.guildId);
        const channel = resolveChannel(guild, params.channelId);

        if (channel.isThread()) {
          return errorResult(
            `Channel "${params.channelId}" is a thread — threads cannot be permanently deleted. ` +
              'Archive it from Discord instead (no archive tool exists yet).',
          );
        }

        const deletedType = typeLabel(channel);

        await channel.delete();

        const structured: DeleteChannelOutput = { deletedChannelId: params.channelId };
        const text = [
          `Deleted ${deletedType} channel "${channel.name}" (${params.channelId}) from ${guild.name}.`,
          ...(channel.type === ChannelType.GuildCategory
            ? ['Note: child channels still exist and are now uncategorized.']
            : []),
        ].join('\n');

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to delete the channel:'));
      }
    },
  );

  server.registerTool(
    'discord_move_channel',
    {
      title: 'Move Guild Channel',
      description:
        'Moves a channel into a category, out of a category (targetCategoryId: null), and optionally sets its position ' +
        'within that category. Requires the bot to have "Manage Channels".\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - channelId (string, required): Channel ID to move. Example: "112233445566778899".\n' +
        '  - targetCategoryId (string or null, required): Category ID to move the channel under, or null to uncategorize it.\n' +
        '  - position (number, optional, >= 0): 0-based position within the target category among channels of the same type (0 = first). Omit to keep the current order.\n' +
        '  - confirm (boolean, required): Human confirmation — set to true only after the human approves.\n\n' +
        'Returns:\n' +
        '  { "channelId", "parentCategoryId", "position" } — state after the move\n\n' +
        'Examples:\n' +
        '  - "Move #events into the Community category" -> {"channelId": "112233445566778899", "targetCategoryId": "998877665544332211", "confirm": true}\n' +
        '  - "Uncategorize #random" -> {"channelId": "112233445566778899", "targetCategoryId": null, "confirm": true}\n\n' +
        'Errors: "Channel not found"/"not a category channel" for bad IDs; categories, threads, and directory channels cannot be moved; "Missing Permissions" without Manage Channels.',
      inputSchema: MoveChannelInput,
      outputSchema: MoveChannelOutput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (params: z.infer<typeof MoveChannelInput>) => {
      try {
        const gateError = requireConfirm(params, 'normal', 'discord_move_channel');
        if (gateError) return gateError;

        const guild = await resolveGuild(deps, params.guildId);
        const channel = resolveChannel(guild, params.channelId);

        if (channel.isThread()) {
          return errorResult(
            `Channel "${params.channelId}" is a thread — threads cannot be moved between categories. ` +
              'Use discord_list_channels to find the parent channel.',
          );
        }
        if (channel.type === ChannelType.GuildCategory) {
          return errorResult('A category channel cannot be moved under another category.');
        }

        // Parent first: position is computed against the target category's
        // channel group, so the move must already be applied when it runs.
        const parent = params.targetCategoryId === null ? null : resolveCategory(guild, params.targetCategoryId);
        let moved = await channel.setParent(parent);
        if (params.position !== undefined) {
          moved = await moved.edit({ position: params.position });
        }

        const structured: MoveChannelOutput = {
          channelId: moved.id,
          parentCategoryId: moved.parentId,
          position: moved.position,
        };

        const text = [
          `Channel "${moved.name}" moved in ${guild.name}.`,
          `  Parent category: ${structured.parentCategoryId ?? 'none (uncategorized)'}`,
          `  Position: ${moved.position}`,
        ].join('\n');

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to move the channel:'));
      }
    },
  );
}