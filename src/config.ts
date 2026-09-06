import 'dotenv/config';

export interface Config {
  /** Discord bot token (DISCORD_TOKEN). Required. */
  discordToken: string;
  /** Default guild ID (GUILD_ID). Optional — used when a tool call omits guildId. */
  guildId: string | null;
}

/**
 * Fails fast with a clear, actionable message when DISCORD_TOKEN is missing,
 * because every tool in this server depends on the bot being logged in.
 */
export function loadConfig(): Config {
  const discordToken = (process.env.DISCORD_TOKEN ?? '').trim();
  if (!discordToken) {
    throw new Error(
      'DISCORD_TOKEN is missing.\n' +
        '  - Copy .env.example to .env and paste your bot token, or\n' +
        '  - Set the DISCORD_TOKEN environment variable.\n' +
        '  Create a bot at https://discord.com/developers/applications (see README) and copy the token ' +
        'from the "Bot" page. Never commit the token.',
    );
  }
  const guildId = (process.env.GUILD_ID ?? '').trim() || null;
  return { discordToken, guildId };
}