import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createDiscordClient, waitForClientReady } from './discordClient.js';
import { registerAnnounceTools } from './tools/announce.js';
import { registerChannelAdminTools } from './tools/channelAdmin.js';
import { registerChannelTools } from './tools/channel.js';
import { registerGuildTools } from './tools/guild.js';
import { registerMemberTools } from './tools/member.js';
import { registerRoleAdminTools } from './tools/roleAdmin.js';
import { registerRoleTools } from './tools/role.js';
import type { ToolDeps } from './tools/helpers.js';

const READY_TIMEOUT_MS = 30_000;

function translateLoginError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid token/i.test(message)) {
    return (
      'ERROR: Invalid Discord token. Check DISCORD_TOKEN in .env.\n' +
      '  - Open https://discord.com/developers/applications, select your bot application, go to "Bot", and copy the token.\n' +
      '  - This MCP server needs its OWN dedicated bot — do not reuse the zeewbot token.'
    );
  }
  if (/disallowed intents/i.test(message)) {
    return (
      'ERROR: Discord rejected the gateway intents.\n' +
      '  - In the Developer Portal, open your application > "Bot" and enable the privileged intents: "Server Members Intent" and "Message Content Intent".\n' +
      '  - Enabling requires the "Bot" permission scope and, on public bots, verification. Then restart this server.'
    );
  }
  return `ERROR: Failed to log in to Discord: ${message}`;
}

async function main(): Promise<void> {
  const config = loadConfig();

  const { client, ready } = createDiscordClient();
  const server = new McpServer({
    name: 'discord-mcp-server',
    version: '1.0.0',
  });

  const deps: ToolDeps = { client, ready, config };
  registerGuildTools(server, deps);
  registerChannelTools(server, deps);
  registerChannelAdminTools(server, deps);
  registerRoleTools(server, deps);
  registerRoleAdminTools(server, deps);
  registerMemberTools(server, deps);
  registerAnnounceTools(server, deps);

  try {
    await client.login(config.discordToken);
    await waitForClientReady(ready, READY_TIMEOUT_MS);
  } catch (error) {
    console.error(translateLoginError(error));
    await client.destroy().catch(() => {});
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[discord-mcp] ready — logged in as ${client.user?.tag} in ${client.guilds.cache.size} guild(s)`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[discord-mcp] ${signal} received — shutting down`);
    try {
      await server.close();
    } catch (error) {
      console.error(`[discord-mcp] error closing MCP server: ${error instanceof Error ? error.message : String(error)}`);
    }
    client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});