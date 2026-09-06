import { ChannelType, DiscordAPIError, type Client, type Guild, type GuildBasedChannel, type User } from 'discord.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.js';

export interface ToolDeps {
  client: Client;
  /** Resolves once the Discord client is ready; tools await it before touching the API. */
  ready: Promise<void>;
  config: Config;
}

/** Annotations for read-only tools: safe to call, no side effects. */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Annotations for write tools: side effects on the outside world. */
export const WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Annotations for hard/destructive write tools: irreversible side effects. */
export const DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export const CHANNEL_TYPE_LABELS: Partial<Record<ChannelType, string>> = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildCategory]: 'category',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.AnnouncementThread]: 'announcement_thread',
  [ChannelType.PublicThread]: 'public_thread',
  [ChannelType.PrivateThread]: 'private_thread',
  [ChannelType.GuildStageVoice]: 'stage_voice',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildMedia]: 'media',
  [ChannelType.GuildDirectory]: 'directory',
};

export function truncate(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, Math.max(0, maxLength - 3))}...`, truncated: true };
}

/**
 * Formats a user's tag: "name#1234" for legacy discriminators, plain
 * username for the modern username system.
 */
export function formatTag(user: Pick<User, 'username' | 'discriminator'>): string {
  return user.discriminator === '0' ? user.username : `${user.username}#${user.discriminator}`;
}

/**
 * Resolves the guild a tool call should operate on:
 *  1. `guildIdParam` (explicit per-call argument) — highest priority
 *  2. `GUILD_ID` from the environment
 *  3. The first guild the bot is in
 *
 * Fails with an actionable error when the guild cannot be resolved.
 */
export async function resolveGuild(deps: ToolDeps, guildIdParam?: string): Promise<Guild> {
  // Tools can only be invoked after the server connects, which happens after
  // 'ready', but the gate guards against any future ordering changes.
  await deps.ready;

  if (guildIdParam) {
    const guild = deps.client.guilds.cache.get(guildIdParam);
    if (!guild) {
      throw new Error(
        `The bot is not in guild "${guildIdParam}". Verify the guild ID (right-click the server icon > Copy Server ID) ` +
          'and that the bot has been invited with the invite URL from the README.',
      );
    }
    return guild;
  }

  if (deps.config.guildId) {
    const guild = deps.client.guilds.cache.get(deps.config.guildId);
    if (!guild) {
      throw new Error(
        `GUILD_ID in the environment is "${deps.config.guildId}" but the bot is not in that guild. ` +
          'Fix GUILD_ID or invite the bot to that server.',
      );
    }
    return guild;
  }

  const first = deps.client.guilds.cache.first();
  if (!first) {
    throw new Error(
      'The bot is not in any guild yet. Invite it with the invite URL from the README ' +
        '(https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=511040), then retry.',
    );
  }
  return first;
}

/**
 * Resolves a channel inside a guild, failing with a friendly message when the
 * bot cannot see it. Non-viewable channels are invisible to the bot.
 */
export function resolveChannel(guild: Guild, channelId: string): GuildBasedChannel {
  const channel = guild.channels.cache.get(channelId);
  if (!channel) {
    throw new Error(
      `Channel "${channelId}" not found in guild "${guild.name}". The channel may not exist, or the bot cannot view it. ` +
        'Use discord_list_channels to find valid channel IDs.',
    );
  }
  return channel;
}

/**
 * Translates discord.js / Discord API errors into friendly, actionable
 * messages. Never leaks stack traces to the MCP client.
 */
export function toFriendlyError(error: unknown, action: string): string {
  if (error instanceof DiscordAPIError) {
    switch (error.code) {
      case 50001:
        return `${action} Discord says "Missing Access" (50001). The bot cannot access this resource — check the channel/category permissions and that the bot role sits above relevant overwrites.`;
      case 50013:
        return `${action} Discord says "Missing Permissions" (50013). Grant the bot the needed permission in Server Settings > Roles, then retry.`;
      case 10003:
        return `${action} Discord says "Unknown Channel" (10003). The channel may have been deleted, or the bot cannot view it. Use discord_list_channels to find valid channel IDs.`;
      case 10004:
        return `${action} Discord says "Unknown Guild" (10004). The guild may have been deleted, or the bot was removed. Check the guild ID and re-invite the bot with the README invite URL.`;
      case 10008:
        return `${action} Discord says "Unknown Message" (10008). The message may have been deleted, or the ID is invalid. Use discord_list_messages to get valid message IDs.`;
      case 50035:
        return `${action} Discord rejected the payload (50035, Invalid Form Body). Check parameter formats and lengths (e.g. embed title <= 256 chars, fields <= 25, valid color hex, https image URLs).`;
      case 20028:
        return `${action} Discord rate-limited the bot (20028). Wait a moment and retry with a lower limit.`;
      default:
        return `${action} Discord API error ${error.code}: ${error.message}`;
    }
  }
  if (error instanceof Error) {
    if (/intent/i.test(error.message)) {
      return `${action} A required Gateway intent is missing. Enable the privileged "Server Members" and "Message Content" intents in the Discord Developer Portal (Application > Bot > Privileged Gateway Intents), then restart the server.`;
    }
    if (/rate limit/i.test(error.message)) {
      return `${action} Discord rate-limited the request. Wait a moment and retry.`;
    }
    return `${action} ${error.message}`;
  }
  return `${action} ${String(error)}`;
}

export function okResult<T extends Record<string, unknown>>(
  structuredContent: T,
  text: string,
): { content: { type: 'text'; text: string }[]; structuredContent: T } {
  return { content: [{ type: 'text', text }], structuredContent };
}

/**
 * Builds a failed tool result (isError: true) with a human-readable message.
 * Tool errors are reported inside the result, not as protocol-level errors.
 */
export function errorResult(text: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

export type ConfirmationMode = 'normal' | 'hard';

export type ConfirmationGateResult = ReturnType<typeof errorResult> | null;

/**
 * Confirmation gate shared by every write tool (CONFIRM-EVERYTHING policy):
 * no write happens without the human's approval. Normal writes require
 * `confirm: true`; hard/destructive writes require the exact string "YES"
 * so a mistakenly produced boolean can never authorize an irreversible action.
 * Returns an error result when the gate is not satisfied, null to proceed.
 */
export function requireConfirm(
  params: { confirm?: unknown },
  mode: ConfirmationMode,
  toolName: string,
): ConfirmationGateResult {
  if (mode === 'hard') {
    if (params.confirm === 'YES') return null;
    return errorResult(
      `${toolName} is a destructive/irreversible action, so it needs EXPLICIT human approval. ` +
        'Ask the human to confirm first, then call the tool again with "confirm": "YES" (exact string).',
    );
  }
  if (params.confirm === true) return null;
  return errorResult(
    `${toolName} writes to Discord, so a human must approve it first. ` +
      'Ask the human to approve the exact parameters, then call the tool again with "confirm": true.',
  );
}