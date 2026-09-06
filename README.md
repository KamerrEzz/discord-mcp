# discord-mcp-server

MCP (Model Context Protocol) server that lets an AI assistant control a dedicated Discord bot — reading server/channel/member/role information and managing roles, channels, and messages under a **CONFIRM-EVERYTHING** policy: no write happens without the human's approval.

- **Transport:** stdio (local — OpenCode, Claude Desktop, etc.)
- **Stack:** Node 20+, TypeScript (strict), discord.js v14, `@modelcontextprotocol/sdk` v1, zod, dotenv
- **Ecosystem:** sibling to `zeewbot` (Zeew Space) but fully standalone: own `package.json`, own `.env`, own **dedicated** bot token.

## Prerequisites

- Node.js 20+ (tested on Node 26) and npm 11
- A **new, dedicated** Discord application (do NOT reuse the zeewbot token)

## 1. Create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it something like `Zeew MCP Bot`.
2. Go to **Bot** and click **Reset Token** → copy the token (this is `DISCORD_TOKEN`).
3. In **Bot > Privileged Gateway Intents**, enable:
   - **Server Members Intent** — required to list/fetch members
   - **Message Content Intent** — required to read recent messages
4. (Optional) **Presence Intent**: only needed if you want live presence/online counts — this project intentionally leaves it off.

## 2. Invite the bot to your guild

Use the invite URL below, replacing `YOUR_CLIENT_ID` with the **Application ID** from the Developer Portal's *General Information* tab:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=268946512
```

Permissions granted (integer `268946512`):

| Permission | Value |
|---|---|
| Add Reactions | 64 |
| Send Messages | 2048 |
| View Channels | 1024 |
| Embed Links | 16384 |
| Attach Files | 32768 |
| Read Message History | 65536 |
| Mention Everyone | 131072 |
| Use External Emojis | 262144 |
| Manage Channels | 16 |
| Manage Roles | 268435456 |

Permissions like **Manage Messages** are not requested; if you need them, add them to the permission integer (see [Discord Permission Calculator](https://discordapi.com/permissions)).

> **Breaking change:** newer builds include role/channel management tools, so the invite now grants **Manage Roles** and **Manage Channels**. Re-invite the bot with the new URL to unlock those tools.

## 3. Configure the environment

```bash
cd discord-mcp
npm install
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_TOKEN=your-bot-token-here
GUILD_ID=
```

- `DISCORD_TOKEN` — **required**. Your dedicated bot token.
- `GUILD_ID` — optional. Default guild used when a tool call omits `guildId`. If empty, the server falls back to the first guild the bot is in. You can also pass `guildId` per tool call.

## 4. Build and run

```bash
npm run build       # tsc → dist/
npm start           # node dist/index.js (stdio)
npm run dev         # tsx watch src/index.ts (development)
```

The server logs to **stderr** only; stdout is reserved for the MCP protocol.

## 5. Register in an MCP client

### OpenCode (`opencode.json`)

```json
{
  "mcp": {
    "discord": {
      "type": "local",
      "command": ["node", "D:/CODE/zeewspace/discord-mcp/dist/index.js"],
      "environment": {
        "DISCORD_TOKEN": "your-bot-token-here",
        "GUILD_ID": "123456789012345678"
      }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["D:/CODE/zeewspace/discord-mcp/dist/index.js"],
      "env": {
        "DISCORD_TOKEN": "your-bot-token-here",
        "GUILD_ID": "123456789012345678"
      }
    }
  }
}
```

Rebuild (`npm run build`) after any source change before restarting the client.

## Tools

All tools accept an optional `guildId` that falls back to `GUILD_ID`, then the first guild the bot is in.

**Confirmation policy (CONFIRM-EVERYTHING):**

- **Every write tool requires confirmation.** Normal writes take `confirm: true` (boolean). Hard/destructive writes take `confirm: "YES"` (the exact string) — a mistakenly produced boolean can never authorize an irreversible action.
- Hard-gated tools: `discord_delete_role`, `discord_reorder_roles`, `discord_delete_channel`, and `discord_post_announcement` **with** a ping (`pingRoleId` / `pingEveryone`). Announcements without pings are normal-confirm.
- When a tool is called without approval, it returns an actionable error explaining exactly what to do — nothing is written.
- Security model: the AI proposes, the human disposes. The assistant should present the exact parameters and ask for approval before calling a write tool.

| Tool | Description | Key params | Confirmation |
|---|---|---|---|
| `discord_get_guild_summary` | Guild overview: members, online approx., channel counts by type, roles, emojis, stickers, boosts | `guildId?` | — (read) |
| `discord_list_roles` | All roles sorted by position (highest first) with colors, highlights, member counts | `guildId?` | — (read) |
| `discord_get_role` | One role by ID | `roleId`, `guildId?` | — (read) |
| `discord_list_channels` | Hierarchical channels: categories with children + uncategorized | `guildId?` | — (read) |
| `discord_get_channel` | Channel details incl. parent category, slowmode, bot permission snapshot | `channelId`, `guildId?` | — (read) |
| `discord_list_messages` | Recent messages (newest first) with pagination via `before` | `channelId`, `limit?` (1–100), `before?` | — (read) |
| `discord_list_members` | Members with top role + join date; filter by `query` | `limit?` (default 50, max 200), `query?` | — (read) |
| `discord_get_member` | Full member profile: nickname, avatar, roles, join/account dates | `memberId`, `guildId?` | — (read) |
| `discord_post_announcement` | Formatted embed with fields/image/thumbnail and optional role/everyone ping | `channelId`, `title`, `message`, `color?`, `fields?`, `imageUrl?`, `thumbnailUrl?`, `pingRoleId?`, `pingEveryone?`, `confirm` | Normal (`true`) / **Hard (`"YES"`) with ping** |
| `discord_send_message` | Plain text message, optionally a reply | `channelId`, `content`, `replyToMessageId?`, `confirm` | Normal |
| `discord_create_role` | Create a role: name, hex color, hoisted/mentionable flags, whitelisted permissions | `name`, `color?`, `permissions?`, `confirm` | Normal |
| `discord_update_role` | Update a role; `permissions` REPLACES the full permission set | `roleId`, `name?`, `color?`, `permissions?`, `confirm` | Normal |
| `discord_delete_role` | Permanently delete a role (members lose it; overwrites stop applying) | `roleId`, `confirm` | **Hard** |
| `discord_assign_role` | Assign a role to a member | `roleId`, `userId`, `confirm` | Normal |
| `discord_unassign_role` | Remove a role from a member | `roleId`, `userId`, `confirm` | Normal |
| `discord_reorder_roles` | Reorder roles (highest first); order = permission precedence; no partial application | `roleIds`, `confirm` | **Hard** |
| `discord_create_channel` | Create text/voice/announcement/forum/category channel (category parent required) | `name`, `type?`, `parentCategoryId?`, `topic?`, `nsfw?`, `confirm` | Normal |
| `discord_update_channel` | Update name/topic/nsfw/slowmode/parent category | `channelId`, `name?`, `topic?`, `nsfw?`, `slowmodeSeconds?`, `parentCategoryId?`, `confirm` | Normal |
| `discord_delete_channel` | Permanently delete a channel (categories keep children, which become uncategorized) | `channelId`, `confirm` | **Hard** |
| `discord_move_channel` | Move a channel into/out of a category and set its position | `channelId`, `targetCategoryId`, `position?`, `confirm` | Normal |

Read tools are annotated `readOnlyHint: true`; write tools are annotated `destructiveHint: false`; hard-gated tools (`discord_delete_role`, `discord_reorder_roles`, `discord_delete_channel`) are annotated `destructiveHint: true`. All write tools are `idempotentHint: false` / `openWorldHint: true`.

## Error handling

Errors are translated into friendly, actionable messages inside tool results (`isError: true`), never raw stack traces:

- `Missing Access (50001)` / `Missing Permissions (50013)` → check channel/category permission overwrites and the bot role's permissions
- `Unknown Channel/Guild/Message (10003/10004/10008)` → wrong ID, or the bot cannot view the resource (use the list tools to discover valid IDs)
- Missing intents → enable the privileged **Server Members** and **Message Content** intents in the Developer Portal and restart
- Invalid token → verify `DISCORD_TOKEN` and that you created a dedicated bot

## Security notes

- The token lives only in `.env` (git-ignored). Never commit it.
- This is a **write-capable** bot (messages, mentions, roles, channels) — invite it only to guilds you trust, and keep `Mention Everyone` permission restricted to announcement channels via channel permission overwrites.
- **CONFIRM-EVERYTHING:** every write tool refuses to act until a human approves (`confirm: true` / `confirm: "YES"`). Hard/destructive actions additionally require the exact string `"YES"`.
- Role permissions are validated against a whitelist that **excludes Administrator** by design — no single boolean confirmation can hand out the most powerful permission.
- The bot can only manage roles/channels below its own highest role; `discord_reorder_roles` rejects the whole request when any listed role is unmanageable (no partial application).
- The server is local-only (stdio); do not expose it on a network.

## Project layout

```
src/
├── index.ts          # entry: config → client → register tools → stdio transport → graceful shutdown
├── config.ts         # typed env config (DISCORD_TOKEN required, GUILD_ID optional)
├── discordClient.ts  # discord.js client (Guilds, GuildMessages, MessageContent, GuildMembers intents) + ready gate
└── tools/
    ├── helpers.ts    # shared: guild/channel resolution, error translation, result builders, confirmation gate
    ├── guild.ts      # discord_get_guild_summary
    ├── channel.ts    # discord_list_channels / discord_get_channel / discord_list_messages
    ├── channelAdmin.ts # discord_create_channel / discord_update_channel / discord_delete_channel / discord_move_channel
    ├── role.ts       # discord_list_roles / discord_get_role
    ├── roleAdmin.ts  # discord_create_role / discord_update_role / discord_delete_role / discord_assign_role / discord_unassign_role / discord_reorder_roles
    ├── member.ts     # discord_list_members / discord_get_member
    └── announce.ts   # discord_post_announcement / discord_send_message
```