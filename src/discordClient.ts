import { Client, GatewayIntentBits } from 'discord.js';

/**
 * A connected Discord client plus a gateway that resolves once the client
 * is ready. Tools await `ready` (via the shared helpers) so every tool call
 * is guaranteed to run against a logged-in, ready client.
 */
export interface DiscordConnection {
  client: Client;
  /** Resolves when the client fires its 'ready' event. Never rejects. */
  ready: Promise<void>;
}

/**
 * Creates the discord.js client with the intents this server needs:
 *  - Guilds: read guild/channel/role metadata
 *  - GuildMessages + MessageContent: read recent messages (privileged intent)
 *  - GuildMembers: list/fetch members (privileged intent)
 *
 * Presence/online stats need the GuildPresences intent, which is intentionally
 * NOT enabled (it is privileged and rarely needed for agent reads).
 */
export function createDiscordClient(): DiscordConnection {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  });

  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  client.once('ready', () => {
    resolveReady();
  });

  // Client-level errors (e.g. dropped connections) must never crash the MCP
  // server; log them to stderr only, since stdout is the MCP transport.
  client.on('error', (error: Error) => {
    console.error(`[discord] client error: ${error.message}`);
  });

  return { client, ready };
}

/**
 * Waits for the `ready` promise, rejecting with a friendly message if the
 * client does not become ready within `timeoutMs`.
 */
export function waitForClientReady(ready: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs} ms waiting for the Discord client to become ready. Check the token, network, and intents.`));
    }, timeoutMs);
    ready.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}