import { PermissionFlagsBits, type PermissionResolvable, type Role, type RoleEditOptions, type RolePosition } from 'discord.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  DESTRUCTIVE_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  errorResult,
  okResult,
  requireConfirm,
  resolveGuild,
  toFriendlyError,
  type ToolDeps,
} from './helpers.js';

/**
 * Canonical permission names accepted by the role tools. Administrator is
 * intentionally excluded: granting it through a single boolean confirmation
 * would bypass the hard-gate protection on the most powerful Discord permission.
 */
const ROLE_PERMISSION_NAMES = Object.keys(PermissionFlagsBits).filter((name) => name !== 'Administrator');

const RolePermissionsInput = z
  .array(z.string())
  .max(ROLE_PERMISSION_NAMES.length, 'Too many permissions provided.')
  .refine((names) => names.every((name) => ROLE_PERMISSION_NAMES.includes(name)), {
    message: `Unknown or excluded permission name(s). Allowed: ${ROLE_PERMISSION_NAMES.join(', ')}.`,
  });

const CreateRoleInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    name: z.string().min(1).max(100).describe('Role name, 1-100 chars. Example: "Event Host".'),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a hex value like "#F9E2A1".')
      .optional()
      .describe('Role color as hex "#RRGGBB". Example: "#F9E2A1".'),
    hoisted: z.boolean().optional().describe('Whether the role is displayed separately in the member list. Example: true.'),
    mentionable: z.boolean().optional().describe('Whether the role can be mentioned by everyone. Example: false.'),
    permissions: RolePermissionsInput.optional().describe(
      'Permission names for the role, e.g. ["KickMembers", "ManageMessages", "MentionEveryone"]. ' +
        'Validated against a whitelist (Administrator excluded). Roles start with no permissions when omitted.',
    ),
    confirm: z.boolean().describe('Human confirmation. Set to true only after the human approves.'),
  })
  .strict();

const RoleAdminOutput = z.object({
  roleId: z.string(),
  guildId: z.string(),
  name: z.string(),
  color: z.string(),
  position: z.number(),
});
type RoleAdminOutput = z.infer<typeof RoleAdminOutput>;

const UpdateRoleInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    roleId: z.string().describe('The role ID to update, e.g. "112233445566778899". Use discord_list_roles to find role IDs.'),
    name: z.string().min(1).max(100).optional().describe('New role name, 1-100 chars. Example: "Events Team".'),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a hex value like "#F9E2A1".')
      .optional()
      .describe('Role color as hex "#RRGGBB". Example: "#F9E2A1".'),
    hoisted: z.boolean().optional().describe('Whether the role is displayed separately in the member list. Example: true.'),
    mentionable: z.boolean().optional().describe('Whether the role can be mentioned by everyone. Example: true.'),
    permissions: RolePermissionsInput.optional().describe(
      'Permission names REPLACING the role\'s ENTIRE current permission set (not merged), ' +
        'e.g. ["KickMembers"]. Omit to leave permissions untouched.',
    ),
    confirm: z.boolean().describe('Human confirmation. Set to true only after the human approves.'),
  })
  .strict();

const DeleteRoleInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    roleId: z.string().describe('The role ID to delete, e.g. "112233445566778899". Use discord_list_roles to find role IDs.'),
    confirm: z.literal('YES').describe('Destructive confirmation. Requires the exact string "YES" after the human approves.'),
  })
  .strict();

const DeleteRoleOutput = z.object({
  deletedRoleId: z.string(),
});
type DeleteRoleOutput = z.infer<typeof DeleteRoleOutput>;

const AssignRoleInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    roleId: z.string().describe('The role ID to assign, e.g. "112233445566778899". Use discord_list_roles to find role IDs.'),
    userId: z.string().describe('The member (user) ID to assign the role to, e.g. "445566778899001122". Use discord_list_members to find IDs.'),
    confirm: z.boolean().describe('Human confirmation. Set to true only after the human approves.'),
  })
  .strict();

const AssignRoleOutput = z.object({
  userId: z.string(),
  roleId: z.string(),
});
type AssignRoleOutput = z.infer<typeof AssignRoleOutput>;

const UnassignRoleInput = AssignRoleInput;

const UnassignRoleOutput = AssignRoleOutput;
type UnassignRoleOutput = z.infer<typeof UnassignRoleOutput>;

const ReorderRolesInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    roleIds: z
      .array(z.string())
      .min(1, 'Provide at least one role ID.')
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate role IDs are not allowed.')
      .describe('Role IDs in the TARGET hierarchy, ordered from HIGHEST position to LOWEST (top first). ' +
        'Example: ["998877665544332211", "112233445566778899"]. Only these roles are reordered; all others keep their positions.'),
    confirm: z.literal('YES').describe('Destructive confirmation. Requires the exact string "YES" after the human approves.'),
  })
  .strict();

const ReorderRolesOutput = z.object({
  orderedCount: z.number(),
  roles: z.array(z.object({ roleId: z.string(), position: z.number() })),
});
type ReorderRolesOutput = z.infer<typeof ReorderRolesOutput>;

function toColorHex(role: { colors: { primaryColor: number } }): string {
  return `#${role.colors.primaryColor.toString(16).padStart(6, '0')}`;
}

function toRoleAdminOutput(guildId: string, role: Role): RoleAdminOutput {
  return {
    roleId: role.id,
    guildId,
    name: role.name,
    color: toColorHex(role),
    position: role.position,
  };
}

export function registerRoleAdminTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'discord_create_role',
    {
      title: 'Create Guild Role',
      description:
        'Creates a role with the given name, optional hex color, hoisted/mentionable flags, and a validated permission list. ' +
        'Requires the bot to have "Manage Roles" and its highest role above the new role.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - name (string, required, 1-100): Role name. Example: "Event Host".\n' +
        '  - color (string, optional): Hex color "#RRGGBB". Example: "#F9E2A1".\n' +
        '  - hoisted (boolean, optional): Show the role separately in the member list.\n' +
        '  - mentionable (boolean, optional): Allow everyone to mention the role.\n' +
        '  - permissions (array of strings, optional): Permission names (discord.js PermissionFlagsBits), e.g. ["KickMembers", "ManageMessages", "MentionEveryone"]. ' +
        'Validated against a whitelist; unknown names are rejected, and "Administrator" is excluded by design.\n' +
        '  - confirm (boolean, required): Human confirmation — set to true only after the human approves.\n\n' +
        'Returns:\n' +
        '  { "roleId", "guildId", "name", "color", "position" }\n\n' +
        'Examples:\n' +
        '  - "Create a red Event Host role that can mention everyone" -> {"name": "Event Host", "color": "#FF0000", "mentionable": true, "permissions": ["MentionEveryone"], "confirm": true}\n\n' +
        'Errors: "Missing Permissions" when the bot lacks Manage Roles; whitelist rejection for unknown permission names; "at or above the bot\'s highest role" cannot be created above it.',
      inputSchema: CreateRoleInput,
      outputSchema: RoleAdminOutput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (params: z.infer<typeof CreateRoleInput>) => {
      try {
        const gateError = requireConfirm(params, 'normal', 'discord_create_role');
        if (gateError) return gateError;

        const guild = await resolveGuild(deps, params.guildId);
        const created = await guild.roles.create({
          name: params.name,
          ...(params.color ? { colors: { primaryColor: parseInt(params.color.slice(1), 16) } } : {}),
          ...(params.hoisted !== undefined ? { hoist: params.hoisted } : {}),
          ...(params.mentionable !== undefined ? { mentionable: params.mentionable } : {}),
          // Zod already validated the names against the PermissionFlagsBits
          // whitelist, so the cast to PermissionResolvable is safe.
          ...(params.permissions ? { permissions: params.permissions as PermissionResolvable } : {}),
        });

        const structured = toRoleAdminOutput(guild.id, created);
        const text = [
          `Role "${created.name}" created in ${guild.name}.`,
          `  Role ID: ${created.id}`,
          `  Color: ${structured.color}`,
          `  Position: ${created.position}`,
        ].join('\n');

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to create the role:'));
      }
    },
  );

  server.registerTool(
    'discord_update_role',
    {
      title: 'Update Guild Role',
      description:
        'Updates a role\'s name, color, hoisted flag, mentionable flag, and/or permissions. ' +
        'When provided, permissions REPLACE the role\'s entire current permission set (not merged). ' +
        'Requires the bot\'s highest role to sit above the edited role.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - roleId (string, required): Role ID to update. Example: "112233445566778899".\n' +
        '  - name (string, optional, 1-100): New role name. Example: "Events Team".\n' +
        '  - color (string, optional): Hex color "#RRGGBB". Example: "#F9E2A1".\n' +
        '  - hoisted (boolean, optional): Separate display in the member list.\n' +
        '  - mentionable (boolean, optional): Allow everyone to mention the role.\n' +
        '  - permissions (array of strings, optional): FULL replacement permission names; omit to leave permissions untouched.\n' +
        '  - confirm (boolean, required): Human confirmation — set to true only after the human approves.\n\n' +
        'Returns:\n' +
        '  { "roleId", "guildId", "name", "color", "position" } — current values after the update\n\n' +
        'Examples:\n' +
        '  - "Rename the Mod role" -> {"roleId": "112233445566778899", "name": "Moderator", "confirm": true}\n' +
        '  - "Replace Mod permissions with Kick and Ban" -> {"roleId": "112233445566778899", "permissions": ["KickMembers", "BanMembers"], "confirm": true}\n\n' +
        'Errors: "Role not found" for bad IDs; roles that are managed (integration/bot/booster) or at/above the bot\'s highest role cannot be edited.',
      inputSchema: UpdateRoleInput,
      outputSchema: RoleAdminOutput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (params: z.infer<typeof UpdateRoleInput>) => {
      try {
        const gateError = requireConfirm(params, 'normal', 'discord_update_role');
        if (gateError) return gateError;

        const guild = await resolveGuild(deps, params.guildId);
        const role = guild.roles.cache.get(params.roleId);
        if (!role) {
          return errorResult(
            `Role "${params.roleId}" not found in guild "${guild.name}". Use discord_list_roles to find valid role IDs.`,
          );
        }
        if (!role.editable) {
          return errorResult(
            `Role "${role.name}" cannot be edited: managed roles (integration/bot/booster) and roles at or above ` +
              'the bot\'s highest role are locked. Move the bot\'s "Manage Roles" role higher in the hierarchy if needed.',
          );
        }

        const data: RoleEditOptions = {};
        if (params.name !== undefined) data.name = params.name;
        if (params.color !== undefined) data.colors = { primaryColor: parseInt(params.color.slice(1), 16) };
        if (params.hoisted !== undefined) data.hoist = params.hoisted;
        if (params.mentionable !== undefined) data.mentionable = params.mentionable;
        if (params.permissions !== undefined) data.permissions = params.permissions as PermissionResolvable;
        if (Object.keys(data).length === 0) {
          return errorResult(
            'No fields to update — provide at least one of name, color, hoisted, mentionable, or permissions.',
          );
        }

        const updated = await role.edit(data);
        const structured = toRoleAdminOutput(guild.id, updated);
        const text = [
          `Role "${updated.name}" updated in ${guild.name}.`,
          `  Role ID: ${updated.id}`,
          `  Color: ${structured.color}`,
          `  Position: ${updated.position}`,
        ].join('\n');

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to update the role:'));
      }
    },
  );

  server.registerTool(
    'discord_delete_role',
    {
      title: 'Delete Guild Role',
      description:
        'Permanently deletes a role.\n\n' +
        'WARNING — destructive (requires confirm: "YES"): this cannot be undone. Members currently holding the role ' +
        'immediately lose it, and every channel/category permission overwrite that references the role stops applying. ' +
        'Roles that are managed (integration/bot/booster) and @everyone cannot be deleted; the bot\'s highest role must sit above the role.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - roleId (string, required): Role ID to delete. Example: "112233445566778899".\n' +
        '  - confirm (string, required): Must be the exact string "YES" after the human approves.\n\n' +
        'Returns:\n' +
        '  { "deletedRoleId" }\n\n' +
        'Examples:\n' +
        '  - "Delete the Event Host role" -> {"roleId": "112233445566778899", "confirm": "YES"}\n\n' +
        'Errors: "Role not found" for bad IDs; managed roles and @everyone cannot be deleted; "Missing Permissions" without Manage Roles.',
      inputSchema: DeleteRoleInput,
      outputSchema: DeleteRoleOutput,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (params: z.infer<typeof DeleteRoleInput>) => {
      try {
        const gateError = requireConfirm(params, 'hard', 'discord_delete_role');
        if (gateError) return gateError;

        const guild = await resolveGuild(deps, params.guildId);
        const role = guild.roles.cache.get(params.roleId);
        if (!role) {
          return errorResult(
            `Role "${params.roleId}" not found in guild "${guild.name}". Use discord_list_roles to find valid role IDs.`,
          );
        }
        if (role.id === guild.roles.everyone.id) {
          return errorResult('@everyone cannot be deleted — every guild needs it.');
        }
        if (role.managed) {
          return errorResult(
            `Role "${role.name}" is managed by an integration/bot/booster system and cannot be deleted.`,
          );
        }
        if (!role.editable) {
          return errorResult(
            `Role "${role.name}" sits at or above the bot's highest role, so the bot cannot delete it. ` +
              'Move the bot\'s "Manage Roles" role higher in the hierarchy if needed.',
          );
        }

        await role.delete();

        const structured: DeleteRoleOutput = { deletedRoleId: params.roleId };
        const text = [
          `Role "${role.name}" deleted from ${guild.name}.`,
          '  Members who held it lost it; permission overwrites referencing it no longer apply.',
        ].join('\n');

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to delete the role:'));
      }
    },
  );

  server.registerTool(
    'discord_assign_role',
    {
      title: 'Assign Role to Member',
      description:
        'Assigns a role to a guild member. Requires the bot to have "Manage Roles" and its highest role above the assigned role.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - roleId (string, required): Role ID to assign. Example: "112233445566778899".\n' +
        '  - userId (string, required): Member (user) ID to receive the role. Example: "445566778899001122".\n' +
        '  - confirm (boolean, required): Human confirmation — set to true only after the human approves.\n\n' +
        'Returns:\n' +
        '  { "userId", "roleId" }\n\n' +
        'Examples:\n' +
        '  - "Give Alice the Event Host role" -> {"roleId": "112233445566778899", "userId": "445566778899001122", "confirm": true}\n\n' +
        'Errors: "Role not found"/"Unknown Member" for bad IDs; "Missing Permissions" when the bot lacks Manage Roles or the role sits above its highest role; @everyone cannot be assigned.',
      inputSchema: AssignRoleInput,
      outputSchema: AssignRoleOutput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (params: z.infer<typeof AssignRoleInput>) => {
      try {
        const gateError = requireConfirm(params, 'normal', 'discord_assign_role');
        if (gateError) return gateError;

        const guild = await resolveGuild(deps, params.guildId);
        const role = guild.roles.cache.get(params.roleId);
        if (!role) {
          return errorResult(
            `Role "${params.roleId}" not found in guild "${guild.name}". Use discord_list_roles to find valid role IDs.`,
          );
        }
        if (role.id === guild.roles.everyone.id) {
          return errorResult('@everyone is already on every member — there is nothing to assign.');
        }

        const member = await guild.members.fetch(params.userId);
        await member.roles.add(params.roleId);

        const structured: AssignRoleOutput = { userId: params.userId, roleId: params.roleId };
        const text = `Role "${role.name}" assigned to ${member.displayName} (${params.userId}).`;

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to assign the role:'));
      }
    },
  );

  server.registerTool(
    'discord_unassign_role',
    {
      title: 'Unassign Role from Member',
      description:
        'Removes a role from a guild member. If the member does not have the role, returns an informational ' +
        'message instead of failing.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - roleId (string, required): Role ID to remove. Example: "112233445566778899".\n' +
        '  - userId (string, required): Member (user) ID to remove the role from. Example: "445566778899001122".\n' +
        '  - confirm (boolean, required): Human confirmation — set to true only after the human approves.\n\n' +
        'Returns:\n' +
        '  { "userId", "roleId" }\n\n' +
        'Examples:\n' +
        '  - "Remove the Event Host role from Alice" -> {"roleId": "112233445566778899", "userId": "445566778899001122", "confirm": true}\n\n' +
        'Errors: "Role not found"/"Unknown Member" for bad IDs; "Missing Permissions" without Manage Roles; @everyone cannot be removed.',
      inputSchema: UnassignRoleInput,
      outputSchema: UnassignRoleOutput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (params: z.infer<typeof UnassignRoleInput>) => {
      try {
        const gateError = requireConfirm(params, 'normal', 'discord_unassign_role');
        if (gateError) return gateError;

        const guild = await resolveGuild(deps, params.guildId);
        const role = guild.roles.cache.get(params.roleId);
        if (!role) {
          return errorResult(
            `Role "${params.roleId}" not found in guild "${guild.name}". Use discord_list_roles to find valid role IDs.`,
          );
        }
        if (role.id === guild.roles.everyone.id) {
          return errorResult('@everyone cannot be removed from a member.');
        }

        const member = await guild.members.fetch(params.userId);

        const structured: UnassignRoleOutput = { userId: params.userId, roleId: params.roleId };
        if (!member.roles.cache.has(params.roleId)) {
          const text = `Member ${member.displayName} does not have role "${role.name}" — nothing to remove.`;
          return okResult(structured, text);
        }

        await member.roles.remove(params.roleId);
        const text = `Role "${role.name}" removed from ${member.displayName} (${params.userId}).`;

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to unassign the role:'));
      }
    },
  );

  server.registerTool(
    'discord_reorder_roles',
    {
      title: 'Reorder Guild Roles',
      description:
        'Reorders the given roles so they end up in the requested hierarchy, HIGHEST first. Role order defines ' +
        'permission precedence (higher roles override lower ones), so this is a destructive, hard-confirmed action.\n\n' +
        'Only the listed roles move — all unlisted roles keep their current positions. The bot can only manage roles ' +
        'strictly below its own highest role, and managed roles (integration/bot/booster) cannot be moved; if any listed ' +
        'role is unmanageable, the whole request is rejected with the blockers listed and NOTHING is applied (no partial reorder).\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - roleIds (array of strings, required): Role IDs in the TARGET order from HIGHEST position to LOWEST (top first). ' +
        'Example: ["998877665544332211", "112233445566778899"].\n' +
        '  - confirm (string, required): Must be the exact string "YES" after the human approves.\n\n' +
        'Returns:\n' +
        '  { "orderedCount", "roles": [ { "roleId", "position" } ] } — positions as reported by Discord after the change\n\n' +
        'Examples:\n' +
        '  - "Make Admin outrank Moderator, and Mod outrank Event Host" -> {"roleIds": ["998877665544332211", "112233445566778899", "445566778899001122"], "confirm": "YES"}\n\n' +
        'Errors: unknown roles, managed roles, @everyone, and roles at/above the bot\'s highest role are rejected together before any change is applied.',
      inputSchema: ReorderRolesInput,
      outputSchema: ReorderRolesOutput,
      annotations: DESTRUCTIVE_ANNOTATIONS,
    },
    async (params: z.infer<typeof ReorderRolesInput>) => {
      try {
        const gateError = requireConfirm(params, 'hard', 'discord_reorder_roles');
        if (gateError) return gateError;

        const guild = await resolveGuild(deps, params.guildId);
        const botHighest = guild.members.me?.roles.highest ?? guild.roles.everyone;

        const failures: string[] = [];
        const listedRoles: Role[] = [];
        for (const roleId of params.roleIds) {
          const role = guild.roles.cache.get(roleId);
          if (!role) {
            failures.push(`"${roleId}" (not found in this guild)`);
            continue;
          }
          if (role.id === guild.roles.everyone.id) {
            failures.push('@everyone (cannot be reordered)');
            continue;
          }
          if (role.managed) {
            failures.push(`"${role.name}" (managed by an integration/bot/booster — position is locked)`);
            continue;
          }
          if (role.comparePositionTo(botHighest) >= 0) {
            failures.push(`"${role.name}" (at or above the bot's highest role "${botHighest.name}")`);
            continue;
          }
          listedRoles.push(role);
        }

        if (failures.length > 0) {
          return errorResult(
            `Cannot reorder roles — ${failures.length} unmanageable role(s): ${failures.join('; ')}. ` +
              'No changes were made. Fix the blockers (or move the bot\'s "Manage Roles" role higher in the hierarchy) and retry.',
          );
        }

        // Target slot for each listed role: the first requested role takes the
        // highest of the occupied slots, the next the second-highest, etc., so
        // unlisted roles keep their exact positions and only listed ones move.
        const slots = listedRoles.map((role) => role.position).sort((a, b) => b - a);
        const targetPositions = new Map<string, number>();
        listedRoles.forEach((role, index) => targetPositions.set(role.id, slots[index]));

        const payload: RolePosition[] = [];
        for (const role of guild.roles.cache.values()) {
          if (role.id === guild.roles.everyone.id) continue;
          payload.push({ role, position: targetPositions.get(role.id) ?? role.position });
        }

        await guild.roles.setPositions(payload);
        await guild.roles.fetch();

        const structured: ReorderRolesOutput = {
          orderedCount: listedRoles.length,
          roles: listedRoles.map((role) => {
            const fresh = guild.roles.cache.get(role.id);
            return { roleId: role.id, position: fresh ? fresh.position : role.position };
          }),
        };

        const lines = [
          `Reordered ${listedRoles.length} role(s) in ${guild.name} (highest first):`,
          ...structured.roles.map((entry) => `  ${guild.roles.cache.get(entry.roleId)?.name ?? entry.roleId} → position ${entry.position}`),
        ];

        return okResult(structured, lines.join('\n'));
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to reorder roles:'));
      }
    },
  );
}