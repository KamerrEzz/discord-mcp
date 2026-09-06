import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { READ_ONLY_ANNOTATIONS, errorResult, formatTag, okResult, resolveGuild, toFriendlyError, type ToolDeps } from './helpers.js';

const ListMembersInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Maximum number of members to return, 1-200. Example: 50.'),
    query: z
      .string()
      .optional()
      .describe('Filter members by username or display name (case-insensitive substring). Example: "kamer".'),
  })
  .strict();

const MemberItemOutput = z.object({
  id: z.string(),
  displayName: z.string(),
  username: z.string(),
  tag: z.string(),
  topRoleName: z.string(),
  joinedAt: z.string().nullable(),
});
type MemberItemOutput = z.infer<typeof MemberItemOutput>;

const ListMembersOutput = z.object({
  guildId: z.string(),
  guildName: z.string(),
  members: z.array(MemberItemOutput),
  count: z.number(),
  hasMore: z.boolean(),
});
type ListMembersOutput = z.infer<typeof ListMembersOutput>;

const GetMemberInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    memberId: z.string().describe('The user/member ID to look up, e.g. "445566778899001122". Use discord_list_members to find IDs.'),
  })
  .strict();

const MemberRoleOutput = z.object({
  id: z.string(),
  name: z.string(),
  colorHex: z.string(),
});
type MemberRoleOutput = z.infer<typeof MemberRoleOutput>;

const GetMemberOutput = z.object({
  memberId: z.string(),
  username: z.string(),
  tag: z.string(),
  globalName: z.string().nullable(),
  displayName: z.string(),
  nickname: z.string().nullable(),
  avatarUrl: z.string(),
  bot: z.boolean(),
  joinedAt: z.string().nullable(),
  accountCreatedAt: z.string(),
  topRoleName: z.string(),
  roles: z.array(MemberRoleOutput),
});
type GetMemberOutput = z.infer<typeof GetMemberOutput>;

/**
 * Builds the shared member summary row (used by list and get tools).
 */
function toMemberItem(member: {
  id: string;
  displayName: string;
  user: { username: string; discriminator: string };
  roles: { highest: { name: string } };
  joinedAt: Date | null;
}): MemberItemOutput {
  return {
    id: member.id,
    displayName: member.displayName,
    username: member.user.username,
    tag: formatTag(member.user),
    topRoleName: member.roles.highest.name,
    joinedAt: member.joinedAt?.toISOString() ?? null,
  };
}

export function registerMemberTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'discord_list_members',
    {
      title: 'List Guild Members',
      description:
        'Returns guild members (newest join first): id, display name, username + tag, top role name, and join timestamp. ' +
        'Supports an optional query filter by username/display name and a limit.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - limit (number, optional): Maximum members to return, 1-200 (default: 50). Example: 100.\n' +
        '  - query (string, optional): Case-insensitive substring match on username or display name. Example: "kamer".\n\n' +
        'Returns:\n' +
        '  { "guildId", "guildName", "members": [ { "id", "displayName", "username", "tag", "topRoleName", "joinedAt" } ], "count", "hasMore" }\n\n' +
        'Examples:\n' +
        '  - "Who is in the server?" -> {"limit": 50}\n' +
        '  - "Find the member named Alice" -> {"query": "alice"}\n\n' +
        'Errors: "Missing Access" hints that the Server Members privileged intent is not enabled ' +
        'or the bot lacks the "View Server Insights"-style access; verify the intent in the Developer Portal.',
      inputSchema: ListMembersInput,
      outputSchema: ListMembersOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: z.infer<typeof ListMembersInput>) => {
      try {
        const guild = await resolveGuild(deps, params.guildId);

        const fetched = await guild.members.fetch({ limit: params.limit });

        let list = [...fetched.values()];
        if (params.query) {
          const query = params.query.toLowerCase();
          list = list.filter(
            (member) =>
              member.user.username.toLowerCase().includes(query) ||
              member.displayName.toLowerCase().includes(query),
          );
        }
        list.sort((a, b) => (b.joinedAt?.getTime() ?? 0) - (a.joinedAt?.getTime() ?? 0));

        const structured: ListMembersOutput = {
          guildId: guild.id,
          guildName: guild.name,
          members: list.map((member) => toMemberItem(member)),
          count: list.length,
          hasMore: !params.query && fetched.size === params.limit,
        };

        const lines = [
          `# Members of ${guild.name}${params.query ? ` matching "${params.query}"` : ''} (${list.length} shown)`,
          '',
          ...structured.members.map(
            (member) =>
              `${member.displayName} (${member.tag}) — ${member.topRoleName} — joined ${member.joinedAt ?? 'unknown'}`,
          ),
        ];

        return okResult(structured, lines.join('\n'));
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to list members:'));
      }
    },
  );

  server.registerTool(
    'discord_get_member',
    {
      title: 'Get Guild Member',
      description:
        'Returns detailed information about one guild member: username, tag, global name, display name (nickname), ' +
        'avatar URL, bot flag, join timestamp, account creation date, top role name, and full role list with colors.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - memberId (string, required): User/member ID, e.g. "445566778899001122".\n\n' +
        'Returns:\n' +
        '  { "memberId", "username", "tag", "globalName", "displayName", "nickname", "avatarUrl", "bot", "joinedAt", "accountCreatedAt", "topRoleName", "roles": [ { "id", "name", "colorHex" } ] }\n\n' +
        'Examples:\n' +
        '  - "Tell me about user 445566778899001122" -> {"memberId": "445566778899001122"}\n\n' +
        'Errors: "Missing Access" hints that the Server Members privileged intent is not enabled.',
      inputSchema: GetMemberInput,
      outputSchema: GetMemberOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: z.infer<typeof GetMemberInput>) => {
      try {
        const guild = await resolveGuild(deps, params.guildId);

        const member = await guild.members.fetch(params.memberId);

        const roles: MemberRoleOutput[] = [...member.roles.cache.values()]
          .sort((a, b) => b.position - a.position)
          .map((role) => ({
            id: role.id,
            name: role.name,
            colorHex: `#${role.color.toString(16).padStart(6, '0')}`,
          }));

        const structured: GetMemberOutput = {
          memberId: member.id,
          username: member.user.username,
          tag: formatTag(member.user),
          globalName: member.user.globalName ?? null,
          displayName: member.displayName,
          nickname: member.nickname ?? null,
          avatarUrl: member.displayAvatarURL({ size: 256 }),
          bot: member.user.bot,
          joinedAt: member.joinedAt?.toISOString() ?? null,
          accountCreatedAt: member.user.createdAt.toISOString(),
          topRoleName: member.roles.highest.name,
          roles,
        };

        const lines = [
          `# ${structured.displayName} (${structured.tag})`,
          `ID: ${member.id}${structured.bot ? ' · BOT' : ''}`,
          `Global name: ${structured.globalName ?? '(none)'}`,
          `Nickname: ${structured.nickname ?? '(none)'}`,
          `Joined: ${structured.joinedAt ?? 'unknown'}`,
          `Account created: ${structured.accountCreatedAt}`,
          `Top role: ${structured.topRoleName}`,
          `Roles (${roles.length}): ${roles.map((role) => role.name).join(', ') || '(only @everyone)'}`,
        ];

        return okResult(structured, lines.join('\n'));
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to get the member:'));
      }
    },
  );
}