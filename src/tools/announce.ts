import { EmbedBuilder } from 'discord.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WRITE_ANNOTATIONS, errorResult, okResult, requireConfirm, resolveChannel, resolveGuild, toFriendlyError, type ToolDeps } from './helpers.js';

/** Zeew Space brand color used when no explicit color is given. */
export const BRAND_COLOR_HEX = '#F9E2A1';
const BRAND_COLOR_INT = 0xf9e2a1;

const EmbedFieldInput = z.object({
  name: z.string().min(1).max(256).describe('Field name, max 256 chars. Example: "When".'),
  value: z.string().min(1).max(1024).describe('Field value, max 1024 chars. Example: "Every Friday 20:00 UTC".'),
  inline: z.boolean().optional().describe('Whether the field renders inline with siblings. Example: true.'),
});

const PostAnnouncementInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    channelId: z.string().describe('The text/announcement channel to post in, e.g. "112233445566778899".'),
    title: z.string().min(1).max(256).describe('Embed title, max 256 chars. Example: "Server maintenance Sunday 03:00 UTC".'),
    message: z.string().min(1).max(4096).describe('Embed description (the announcement body), max 4096 chars.'),
    color: z
      .string()
      .regex(/^#?[0-9A-Fa-f]{6}$/, 'Color must be a 6-digit hex value like "#F9E2A1" or "F9E2A1".')
      .optional()
      .describe('Embed color as hex, e.g. "#F9E2A1". Defaults to the brand color #F9E2A1.'),
    fields: z
      .array(EmbedFieldInput)
      .max(25)
      .optional()
      .describe('Optional embed fields (max 25). Example: [{ "name": "When", "value": "Friday 20:00 UTC", "inline": true }].'),
    imageUrl: z.string().url().optional().describe('Optional large image URL for the embed (https recommended). Example: "https://zeew.space/banner.png".'),
    thumbnailUrl: z.string().url().optional().describe('Optional thumbnail image URL (https recommended). Example: "https://zeew.space/logo.png".'),
    pingRoleId: z.string().optional().describe('Role ID to ping (rendered as @role on its own line). Example: "112233445566778899".'),
    pingEveryone: z.boolean().optional().describe('Ping @everyone on its own line. Requires the "Mention Everyone" permission; ignored if pingRoleId is also set.'),
    confirm: z
      .union([z.literal('YES'), z.boolean()])
      .describe('Human confirmation. Without pings, set to true after the human approves. ' +
        'WITH a ping (pingRoleId or pingEveryone), this becomes a hard-gate: the exact string "YES" is required.'),
  })
  .strict();

const AnnouncementResultOutput = z.object({
  messageId: z.string(),
  channelId: z.string(),
  guildId: z.string(),
});
type AnnouncementResultOutput = z.infer<typeof AnnouncementResultOutput>;

const SendMessageInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    channelId: z.string().describe('The text channel to send the message to, e.g. "112233445566778899".'),
    content: z.string().min(1).max(2000).describe('Plain text message content, max 2000 chars. Example: "Hello from the MCP server!".'),
    replyToMessageId: z.string().optional().describe('Message ID to reply to. Example: "998877665544332211".'),
    confirm: z.boolean().describe('Human confirmation. Set to true only after the human approves.'),
  })
  .strict();

const SendMessageOutput = z.object({
  messageId: z.string(),
  channelId: z.string(),
  guildId: z.string(),
});
type SendMessageOutput = z.infer<typeof SendMessageOutput>;

export function registerAnnounceTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'discord_post_announcement',
    {
      title: 'Post Announcement',
      description:
        'Sends a formatted announcement embed to a channel. Supports title, body, color, up to 25 fields, image, ' +
        'thumbnail, and an optional role/everyone ping.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID. Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - channelId (string, required): Text/announcement channel to post in.\n' +
        '  - title (string, required, max 256): Embed title.\n' +
        '  - message (string, required, max 4096): Embed description (the announcement body).\n' +
        '  - color (string, optional): Hex color, e.g. "#F9E2A1". Default: #F9E2A1 (Zeew brand color).\n' +
        '  - fields (array, optional, max 25): { name (<=256), value (<=1024), inline? }.\n' +
        '  - imageUrl / thumbnailUrl (string, optional): https image URLs.\n' +
        '  - pingRoleId (string, optional): Pings the role as `<@&roleId>` on its own line (requires "Mention Everyone" permission).\n' +
        '  - pingEveryone (boolean, optional): Pings @everyone on its own line; ignored when pingRoleId is set.\n' +
        '  - confirm (boolean or string, required): CONFIRM-EVERYTHING gate (breaking change). Without pings, set true after human approval. ' +
        'WITH a ping (pingRoleId or pingEveryone) this is a hard gate: use the exact string "YES", because pinging a role/everyone is disruptive.\n\n' +
        'Returns:\n' +
        '  { "messageId", "channelId", "guildId" }\n\n' +
        'Examples:\n' +
        '  - Announce an event WITHOUT pings -> {"channelId": "112233445566778899", "title": "Community Night", "message": "Join us Friday 20:00 UTC!", "fields": [{"name": "Where", "value": "Stage", "inline": true}], "confirm": true}\n' +
        '  - Announce WITH a role ping -> {"channelId": "112233445566778899", "title": "Community Night", "message": "Join us Friday 20:00 UTC!", "pingRoleId": "112233445566778899", "confirm": "YES"}\n\n' +
        'Errors: "Channel not found" for bad IDs; "Missing Permissions" when the bot lacks Send Messages / Embed Links / Mention Everyone.',
      inputSchema: PostAnnouncementInput,
      outputSchema: AnnouncementResultOutput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (params: z.infer<typeof PostAnnouncementInput>) => {
      try {
        // Hard gate when the announcement pings a role or @everyone — pinging is
        // disruptive, so a plain boolean is never enough for it.
        const hasPing = params.pingRoleId !== undefined || params.pingEveryone === true;
        const gateError = requireConfirm(params, hasPing ? 'hard' : 'normal', 'discord_post_announcement');
        if (gateError) return gateError;

        const guild = await resolveGuild(deps, params.guildId);
        const channel = resolveChannel(guild, params.channelId);

        if (!channel.isSendable()) {
          return errorResult(
            `Cannot post to channel "${params.channelId}" (${channel.name}): it is not a message-sendable channel. ` +
              'Use a text or announcement channel. Use discord_list_channels to find one.',
          );
        }

        const colorInt = params.color ? parseInt(params.color.replace('#', ''), 16) : BRAND_COLOR_INT;

        const embed = new EmbedBuilder()
          .setTitle(params.title)
          .setDescription(params.message)
          .setColor(colorInt)
          .setTimestamp();
        if (params.imageUrl) {
          embed.setImage(params.imageUrl);
        }
        if (params.thumbnailUrl) {
          embed.setThumbnail(params.thumbnailUrl);
        }
        if (params.fields && params.fields.length > 0) {
          embed.addFields(
            params.fields.map((field) => ({
              name: field.name,
              value: field.value,
              inline: field.inline ?? false,
            })),
          );
        }

        const mention = params.pingEveryone ? '@everyone' : params.pingRoleId ? `<@&${params.pingRoleId}>` : undefined;

        const sent = await channel.send({
          ...(mention ? { content: mention } : {}),
          embeds: [embed],
        });

        const structured: AnnouncementResultOutput = {
          messageId: sent.id,
          channelId: sent.channelId,
          guildId: guild.id,
        };

        const text = [
          `Announcement posted to #${channel.name}:`,
          `  Title: ${params.title}`,
          `  Message ID: ${sent.id}`,
          ...(mention ? [`  Mention: ${mention}`] : []),
        ].join('\n');

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to post the announcement:'));
      }
    },
  );

  server.registerTool(
    'discord_send_message',
    {
      title: 'Send Message',
      description:
        'Sends a plain text message to a channel, optionally as a reply to an existing message.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID. Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - channelId (string, required): Text channel to send to.\n' +
        '  - content (string, required, max 2000): The message text.\n' +
        '  - replyToMessageId (string, optional): Message ID to reply to.\n' +
        '  - confirm (boolean, required): CONFIRM-EVERYTHING gate (breaking change). Set to true only after the human approves.\n\n' +
        'Returns:\n' +
        '  { "messageId", "channelId", "guildId" }\n\n' +
        'Examples:\n' +
        '  - "Say hello in #general" -> {"channelId": "112233445566778899", "content": "Hello from the MCP bot!", "confirm": true}\n' +
        '  - Reply to a message -> {"channelId": "112233445566778899", "content": "Agreed!", "replyToMessageId": "998877665544332211", "confirm": true}\n\n' +
        'Errors: "Channel not found" for bad IDs; "Missing Permissions" when the bot lacks Send Messages.',
      inputSchema: SendMessageInput,
      outputSchema: SendMessageOutput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (params: z.infer<typeof SendMessageInput>) => {
      try {
        const gateError = requireConfirm(params, 'normal', 'discord_send_message');
        if (gateError) return gateError;

        const guild = await resolveGuild(deps, params.guildId);
        const channel = resolveChannel(guild, params.channelId);

        if (!channel.isSendable()) {
          return errorResult(
            `Cannot send to channel "${params.channelId}" (${channel.name}): it is not a message-sendable channel. ` +
              'Use a text or announcement channel. Use discord_list_channels to find one.',
          );
        }

        const channelId = channel.id;
        const sent = await channel.send({
          content: params.content,
          ...(params.replyToMessageId ? { reply: { messageReference: params.replyToMessageId } } : {}),
        });

        const structured: SendMessageOutput = {
          messageId: sent.id,
          channelId,
          guildId: guild.id,
        };

        const text = `Message sent to #${channel.name} (message ID ${sent.id}).`;

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to send the message:'));
      }
    },
  );
}