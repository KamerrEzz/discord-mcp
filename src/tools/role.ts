import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { READ_ONLY_ANNOTATIONS, errorResult, okResult, resolveGuild, toFriendlyError, type ToolDeps } from './helpers.js';

const GuildIdParam = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
  })
  .strict();

const RoleSummaryOutput = z.object({
  id: z.string(),
  name: z.string(),
  colorHex: z.string(),
  hoisted: z.boolean(),
  mentionable: z.boolean(),
  position: z.number(),
  permissions: z.array(z.string()),
  memberCount: z.number(),
});

const ListRolesInput = GuildIdParam;

const ListRolesOutput = z.object({
  guildId: z.string(),
  guildName: z.string(),
  roles: z.array(RoleSummaryOutput),
  totalRoleCount: z.number(),
});

const GetRoleInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    roleId: z.string().describe('The role ID to inspect, e.g. "112233445566778899". Use discord_list_roles to find role IDs.'),
  })
  .strict();

const GetRoleOutput = RoleSummaryOutput.extend({
  guildId: z.string(),
  guildName: z.string(),
});

const MAX_CACHED_MEMBERS_FOR_COUNTS = 1000;

/**
 * Returns a role summary with human-readable permission highlights.
 */
function toRoleSummary(role: { id: string; name: string; color: number; hoist: boolean; mentionable: boolean; position: number; permissions: { toArray(): string[] }; members: { size: number } }): z.infer<typeof RoleSummaryOutput> {
  const permissions = role.permissions.toArray();
  const highlighted = permissions.includes('Administrator') ? ['Administrator'] : permissions;
  return {
    id: role.id,
    name: role.name,
    colorHex: `#${role.color.toString(16).padStart(6, '0')}`,
    hoisted: role.hoist,
    mentionable: role.mentionable,
    position: role.position,
    permissions: highlighted,
    memberCount: role.members.size,
  };
}

export function registerRoleTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'discord_list_roles',
    {
      title: 'List Guild Roles',
      description:
        'Returns every role in the guild, sorted by position (highest first): id, name, hex color, hoisted, mentionable, ' +
        'position, human-readable permission highlights, and member count.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n\n' +
        'Returns:\n' +
        '  { "guildId": string, "guildName": string, "roles": [ { "id", "name", "colorHex", "hoisted", "mentionable", "position", "permissions": string[], "memberCount" } ], "totalRoleCount": number }\n\n' +
        'Examples:\n' +
        '  - "Which roles exist?" -> {} (uses GUILD_ID)\n' +
        '  - "List roles in 123456789012345678" -> {"guildId": "123456789012345678"}\n\n' +
        'Note: member counts reflect up to 1000 cached members, so very large servers may undercount.',
      inputSchema: ListRolesInput,
      outputSchema: ListRolesOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: z.infer<typeof ListRolesInput>) => {
      try {
        const guild = await resolveGuild(deps, params.guildId);

        // Best-effort member cache warm-up so role member counts are meaningful.
        try {
          await guild.members.fetch({ limit: MAX_CACHED_MEMBERS_FOR_COUNTS });
        } catch {
          // Member counts will reflect whatever is already cached.
        }

        const roles = [...guild.roles.cache.values()].sort((a, b) => {
          const byPosition = b.position - a.position;
          if (byPosition !== 0) return byPosition;
          return BigInt(b.id) > BigInt(a.id) ? 1 : -1;
        });

        const structured: z.infer<typeof ListRolesOutput> = {
          guildId: guild.id,
          guildName: guild.name,
          roles: roles.map((role) => toRoleSummary(role)),
          totalRoleCount: roles.length,
        };

        const text = [
          `# Roles in ${guild.name} (${roles.length} total)`,
          '',
          ...roles.map(
            (role) =>
              `${role.name} — ${toRoleSummary(role).colorHex}${role.hoist ? ' (hoisted)' : ''}${role.mentionable ? ' (mentionable)' : ''}` +
              ` | position ${role.position} | ${role.members.size} members | ${role.permissions.toArray().length} permission bit(s)`,
          ),
        ].join('\n');

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to list roles:'));
      }
    },
  );

  server.registerTool(
    'discord_get_role',
    {
      title: 'Get Guild Role',
      description:
        'Returns one role by ID with the same fields as discord_list_roles: id, name, hex color, hoisted, mentionable, ' +
        'position, human-readable permission highlights, and member count.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - roleId (string, required): Role ID, e.g. "112233445566778899".\n\n' +
        'Returns:\n' +
        '  { "guildId", "guildName", "id", "name", "colorHex", "hoisted", "mentionable", "position", "permissions": string[], "memberCount" }\n\n' +
        'Examples:\n' +
        '  - "What does the Moderator role do?" -> {"roleId": "112233445566778899"}\n\n' +
        'Errors: "Role not found" when the ID is wrong or the bot cannot see the role.',
      inputSchema: GetRoleInput,
      outputSchema: GetRoleOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: z.infer<typeof GetRoleInput>) => {
      try {
        const guild = await resolveGuild(deps, params.guildId);

        // Best-effort member cache warm-up so the member count is meaningful.
        try {
          await guild.members.fetch({ limit: MAX_CACHED_MEMBERS_FOR_COUNTS });
        } catch {
          // Member count will reflect whatever is already cached.
        }

        const role = guild.roles.cache.get(params.roleId);
        if (!role) {
          return errorResult(
            `Role "${params.roleId}" not found in guild "${guild.name}". Use discord_list_roles to find valid role IDs.`,
          );
        }

        const structured: z.infer<typeof GetRoleOutput> = {
          guildId: guild.id,
          guildName: guild.name,
          ...toRoleSummary(role),
        };

        const text = [
          `# Role ${role.name} (${role.id})`,
          `Color: ${structured.colorHex}`,
          `Position: ${role.position}`,
          `Hoisted: ${role.hoist} · Mentionable: ${role.mentionable}`,
          `Members with role (cached): ${role.members.size}`,
          `Permissions: ${structured.permissions.join(', ') || 'none set'}`,
        ].join('\n');

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to get the role:'));
      }
    },
  );
}