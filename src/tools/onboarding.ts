import {
  GuildOnboardingMode,
  GuildOnboardingPromptType,
  type Emoji,
  type Guild,
  type GuildChannel,
  type GuildEmoji,
  type GuildOnboarding,
  type GuildOnboardingEditOptions,
  type GuildOnboardingPromptData,
  type GuildOnboardingPromptOptionData,
  type Role,
} from 'discord.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  errorResult,
  okResult,
  requireConfirm,
  resolveGuild,
  toFriendlyError,
  type ToolDeps,
} from './helpers.js';

const GuildIdParam = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
  })
  .strict();

const OnboardingModeInput = z.enum(['ONBOARDING_DEFAULT', 'ONBOARDING_ADVANCED']);

const PromptTypeInput = z.enum(['MULTIPLE_CHOICE', 'DROPDOWN']);

const OnboardingOptionInput = z
  .object({
    id: z.string().optional().describe('Existing option ID to update; omit to create a new option.'),
    title: z.string().min(1).max(100).describe('Option title, 1-100 chars. Example: "Gaming".'),
    description: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .describe('Option description, max 200 chars. Pass null to clear it.'),
    emoji: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('Emoji: "name", "name:id", "<:name:id>", or "<a:name:id>" for animated. Pass null to clear it.'),
    roleIds: z
      .array(z.string())
      .max(20, 'Too many role IDs provided.')
      .optional()
      .describe('Role IDs assigned to the member when this option is selected.'),
    channelIds: z
      .array(z.string())
      .max(20, 'Too many channel IDs provided.')
      .optional()
      .describe('Channel IDs the member is added to when this option is selected.'),
  })
  .strict();

const OnboardingPromptInput = z
  .object({
    id: z.string().optional().describe('Existing prompt ID to update; omit to create a new prompt.'),
    title: z.string().min(1).max(300).describe('Prompt title, 1-300 chars. Example: "What are you here for?"'),
    singleSelect: z.boolean().optional().describe('Whether members may only pick one option. Example: false.'),
    required: z.boolean().optional().describe('Whether the prompt must be answered to finish onboarding. Example: true.'),
    inOnboarding: z.boolean().optional().describe('Whether the prompt shows in the onboarding flow (vs the Channels & Roles tab). Example: true.'),
    type: PromptTypeInput.optional().describe("Prompt type: 'MULTIPLE_CHOICE' or 'DROPDOWN'. Defaults to MULTIPLE_CHOICE."),
    options: z
      .array(OnboardingOptionInput)
      .min(1, 'Each prompt needs at least one option.')
      .max(25, 'Too many options for one prompt — Discord rejects oversized prompt payloads.')
      .describe('Options for this prompt. When this prompt already exists, its entire current option list is replaced.'),
  })
  .strict();

const GetOnboardingInput = GuildIdParam;

const OnboardingOptionOutput = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  emoji: z.string().nullable(),
  roleIds: z.array(z.string()),
  channelIds: z.array(z.string()),
});
type OnboardingOptionOutput = z.infer<typeof OnboardingOptionOutput>;

const OnboardingPromptOutput = z.object({
  id: z.string(),
  title: z.string(),
  singleSelect: z.boolean(),
  required: z.boolean(),
  inOnboarding: z.boolean(),
  type: z.object({
    name: z.string(),
    value: z.number(),
  }),
  options: z.array(OnboardingOptionOutput),
});
type OnboardingPromptOutput = z.infer<typeof OnboardingPromptOutput>;

const OnboardingModeOutput = z.object({
  name: z.string(),
  value: z.number(),
});
type OnboardingModeOutput = z.infer<typeof OnboardingModeOutput>;

const OnboardingConfigOutput = z.object({
  guildId: z.string(),
  enabled: z.boolean(),
  mode: OnboardingModeOutput,
  defaultChannels: z.array(z.object({ id: z.string(), name: z.string() })),
  prompts: z.array(OnboardingPromptOutput),
});
type OnboardingConfigOutput = z.infer<typeof OnboardingConfigOutput>;

const UpdateOnboardingInput = z
  .object({
    guildId: z
      .string()
      .optional()
      .describe('Guild (server) ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.'),
    prompts: z
      .array(OnboardingPromptInput)
      .max(25, 'Too many prompts — Discord rejects oversized onboarding payloads.')
      .optional()
      .describe(
        'FULL REPLACEMENT of the entire prompt list: provide EVERY prompt you want to keep (pass existing ids for ' +
          'prompts being edited, omit ids for new ones) — any prompt not listed here is REMOVED. The prompts are ' +
          'shown to members in the order given.',
      ),
    defaultChannelIds: z
      .array(z.string())
      .optional()
      .describe(
        'FULL REPLACEMENT of the default-channel list (channels new members are auto-opted into): every channel a ' +
          'member should receive is listed here — any channel not listed is REMOVED. Pass [] to clear them all.',
      ),
    enabled: z.boolean().optional().describe('Whether onboarding is enabled. Example: true.'),
    mode: OnboardingModeInput.optional().describe("Onboarding mode: 'ONBOARDING_DEFAULT' or 'ONBOARDING_ADVANCED'."),
    confirm: z.boolean().describe('Human confirmation. Set to true only after the human approves.'),
  })
  .strict();

const PROMPT_TYPE_TO_ENUM: Record<z.infer<typeof PromptTypeInput>, GuildOnboardingPromptType> = {
  MULTIPLE_CHOICE: GuildOnboardingPromptType.MultipleChoice,
  DROPDOWN: GuildOnboardingPromptType.Dropdown,
};

const ONBOARDING_MODE_TO_ENUM: Record<z.infer<typeof OnboardingModeInput>, GuildOnboardingMode> = {
  ONBOARDING_DEFAULT: GuildOnboardingMode.OnboardingDefault,
  ONBOARDING_ADVANCED: GuildOnboardingMode.OnboardingAdvanced,
};

function onboardingModeName(mode: GuildOnboardingMode): string {
  const name = GuildOnboardingMode[mode];
  return typeof name === 'string' ? name : `UNKNOWN(${mode})`;
}

function promptTypeName(type: GuildOnboardingPromptType): string {
  const name = GuildOnboardingPromptType[type];
  return typeof name === 'string' ? name : `UNKNOWN(${type})`;
}

/**
 * Renders an option's emoji as "name" or "name:id" (null when absent).
 */
function toEmojiLabel(emoji: Emoji | GuildEmoji | null): string | null {
  if (!emoji || !emoji.name) return null;
  return emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
}

/**
 * Maps a fresh GuildOnboarding into the shared output shape. Collections must
 * be spread to arrays; channel/role Collections may hold undefined entries
 * when the bot does not have that channel/role cached, so those are dropped.
 */
function toOnboardingConfigOutput(onboarding: GuildOnboarding): OnboardingConfigOutput {
  return {
    guildId: onboarding.guildId,
    enabled: onboarding.enabled,
    mode: { name: onboardingModeName(onboarding.mode), value: onboarding.mode },
    defaultChannels: [...onboarding.defaultChannels.values()]
      .filter((channel): channel is GuildChannel => channel !== undefined)
      .map((channel) => ({ id: channel.id, name: channel.name })),
    prompts: [...onboarding.prompts.values()].map((prompt) => ({
      id: prompt.id,
      title: prompt.title,
      singleSelect: prompt.singleSelect,
      required: prompt.required,
      inOnboarding: prompt.inOnboarding,
      type: { name: promptTypeName(prompt.type), value: prompt.type },
      options: [...prompt.options.values()].map((option) => ({
        id: option.id,
        title: option.title,
        description: option.description,
        emoji: toEmojiLabel(option.emoji),
        roleIds: [...option.roles.values()]
          .filter((role): role is Role => role !== undefined)
          .map((role) => role.id),
        channelIds: [...option.channels.values()]
          .filter((channel): channel is GuildChannel => channel !== undefined)
          .map((channel) => channel.id),
      })),
    })),
  };
}

/**
 * Human-readable summary shared by both tools. Role/channel names are resolved
 * from the guild cache when available, falling back to raw IDs.
 */
function toOnboardingText(guild: Guild, config: OnboardingConfigOutput): string {
  const lines = [
    `# Onboarding for ${guild.name} (${guild.id})`,
    `Enabled: ${config.enabled} · Mode: ${config.mode.name} (${config.mode.value})`,
    `Default channels: ${
      config.defaultChannels.length > 0 ? config.defaultChannels.map((channel) => `#${channel.name}`).join(', ') : 'none'
    }`,
  ];

  for (const prompt of config.prompts) {
    lines.push('');
    lines.push(`## ${prompt.title} [${prompt.type.name}]`);
    lines.push(
      `  single select: ${prompt.singleSelect} · required: ${prompt.required} · in onboarding: ${prompt.inOnboarding}`,
    );
    for (const option of prompt.options) {
      const roleNames = option.roleIds.map((roleId) => guild.roles.cache.get(roleId)?.name ?? roleId);
      const channelNames = option.channelIds.map((channelId) => guild.channels.cache.get(channelId)?.name ?? channelId);
      lines.push(`  - ${option.title}${option.emoji ? ` ${option.emoji}` : ''}${option.description ? ` — ${option.description}` : ''}`);
      lines.push(
        `      roles (${roleNames.length}): ${roleNames.join(', ') || 'none'} · channels (${channelNames.length}): ${channelNames.join(', ') || 'none'}`,
      );
    }
  }

  return lines.join('\n');
}

export function registerOnboardingTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'discord_get_onboarding',
    {
      title: 'Get Guild Onboarding',
      description:
        'Returns the full onboarding configuration for a guild: enabled flag, mode, default channels, and every prompt ' +
        'with its options (emoji, assigned roles, and assigned channels). Read-only.\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n\n' +
        'Returns:\n' +
        '  { "guildId", "enabled", "mode": { "name", "value" }, "defaultChannels": [ { "id", "name" } ], ' +
        '"prompts": [ { "id", "title", "singleSelect", "required", "inOnboarding", "type": { "name", "value" }, ' +
        '"options": [ { "id", "title", "description", "emoji", "roleIds": string[], "channelIds": string[] } ] } ] }\n' +
        '  mode name is "ONBOARDING_DEFAULT" or "ONBOARDING_ADVANCED"; prompt type name is "MultipleChoice" or "Dropdown".\n\n' +
        'Examples:\n' +
        '  - "What is the current onboarding setup?" -> {} (uses GUILD_ID)\n' +
        '  - "Show onboarding for 123456789012345678" -> {"guildId": "123456789012345678"}\n\n' +
        'Errors: "Unknown Guild" (10004) when the guild ID is wrong or the bot was removed; the guild may also have ' +
        'onboarding disabled or unconfigured (not a Community server) — Discord still returns a config with enabled=false.',
      inputSchema: GetOnboardingInput,
      outputSchema: OnboardingConfigOutput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: z.infer<typeof GetOnboardingInput>) => {
      try {
        const guild = await resolveGuild(deps, params.guildId);
        const onboarding = await guild.fetchOnboarding();

        const structured = toOnboardingConfigOutput(onboarding);
        const text = toOnboardingText(guild, structured);

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to fetch onboarding:'));
      }
    },
  );

  server.registerTool(
    'discord_update_onboarding',
    {
      title: 'Update Guild Onboarding',
      description:
        'Updates the guild onboarding configuration (enabled flag, mode, default channels, and prompts).\n\n' +
        'WARNING — FULL REPLACEMENT for prompts and defaultChannelIds: this endpoint does a PUT, so when "prompts" is ' +
        'provided it REPLACES the ENTIRE prompt list (any prompt you omit is REMOVED and members lose those options), ' +
        'and when "defaultChannelIds" is provided it REPLACES the ENTIRE default-channel list (any channel omitted is ' +
        'REMOVED). To keep existing items, include them with their current IDs. Pass [] (with the field present) to ' +
        'clear a list entirely.\n\n' +
        'This is a server configuration change and IS reversible — you can re-edit the onboarding afterward to restore ' +
        'previous values — but a wrong full replacement is disruptive to your members, so it needs human approval like ' +
        'any write (confirm: true).\n\n' +
        'Requires the bot to have the Manage Server permission, and the guild must be a Community server with ' +
        'onboarding available (otherwise Discord rejects the request).\n\n' +
        'Args:\n' +
        '  - guildId (string, optional): Guild ID, e.g. "123456789012345678". Defaults to GUILD_ID env, then the first guild the bot is in.\n' +
        '  - prompts (array, optional): FULL REPLACEMENT of the prompt list, shown in the order given. Each item: ' +
        '{ "id" (string, omit for new prompts), "title" (required, 1-300), "singleSelect" (boolean), "required" (boolean), ' +
        '"inOnboarding" (boolean), "type" ("MULTIPLE_CHOICE"|"DROPDOWN"), "options" (required array of 1-25, each: ' +
        '{ "id" (omit for new), "title" (required, 1-100), "description" (string|null), "emoji" (string|null), ' +
        '"roleIds" (string[]), "channelIds" (string[]) }) }. When an existing prompt/option is edited without an id, ' +
        'it is treated as NEW.\n' +
        '  - defaultChannelIds (array of strings, optional): FULL REPLACEMENT of channels new members are auto-opted into.\n' +
        '  - enabled (boolean, optional): Whether onboarding is enabled.\n' +
        '  - mode (string, optional): "ONBOARDING_DEFAULT" or "ONBOARDING_ADVANCED".\n' +
        '  - confirm (boolean, required): Human confirmation — set to true only after the human approves.\n\n' +
        'Returns:\n' +
        '  The full onboarding config after the change — same shape as discord_get_onboarding, so the caller sees the PUT result.\n\n' +
        'Examples:\n' +
        '  - "Add a required Dropdown prompt asking what members are here for, with a Gaming option granting the Gaming role and #gaming channel" ' +
        '-> {"prompts": [{"title": "What are you here for?", "required": true, "type": "DROPDOWN", "options": [{"title": "Gaming", "roleIds": ["112233445566778899"], "channelIds": ["998877665544332211"]}]}], "confirm": true} ' +
        '(note: this REPLACES all existing prompts)\n' +
        '  - "Enable onboarding in advanced mode" -> {"enabled": true, "mode": "ONBOARDING_ADVANCED", "confirm": true}\n\n' +
        'Errors: "Missing Permissions" (50013) without Manage Server; 50035 Invalid Form Body for oversized/empty payloads; ' +
        '"Unknown Guild" (10004) for bad guild IDs; non-Community guilds are rejected by Discord.',
      inputSchema: UpdateOnboardingInput,
      outputSchema: OnboardingConfigOutput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (params: z.infer<typeof UpdateOnboardingInput>) => {
      try {
        const gateError = requireConfirm(params, 'normal', 'discord_update_onboarding');
        if (gateError) return gateError;

        const guild = await resolveGuild(deps, params.guildId);

        const editOptions: GuildOnboardingEditOptions = {};
        if (params.prompts !== undefined) {
          editOptions.prompts = params.prompts.map((prompt): GuildOnboardingPromptData => ({
            ...(prompt.id !== undefined ? { id: prompt.id } : {}),
            title: prompt.title,
            ...(prompt.singleSelect !== undefined ? { singleSelect: prompt.singleSelect } : {}),
            ...(prompt.required !== undefined ? { required: prompt.required } : {}),
            ...(prompt.inOnboarding !== undefined ? { inOnboarding: prompt.inOnboarding } : {}),
            ...(prompt.type !== undefined ? { type: PROMPT_TYPE_TO_ENUM[prompt.type] } : {}),
            options: prompt.options.map((option): GuildOnboardingPromptOptionData => ({
              ...(option.id !== undefined ? { id: option.id } : {}),
              title: option.title,
              ...(option.description !== undefined ? { description: option.description } : {}),
              ...(option.emoji !== undefined ? { emoji: option.emoji } : {}),
              ...(option.roleIds !== undefined ? { roles: option.roleIds } : {}),
              ...(option.channelIds !== undefined ? { channels: option.channelIds } : {}),
            })),
          }));
        }
        if (params.defaultChannelIds !== undefined) {
          editOptions.defaultChannels = params.defaultChannelIds;
        }
        if (params.enabled !== undefined) editOptions.enabled = params.enabled;
        if (params.mode !== undefined) editOptions.mode = ONBOARDING_MODE_TO_ENUM[params.mode];

        if (Object.keys(editOptions).length === 0) {
          return errorResult(
            'No fields to update — provide at least one of prompts, defaultChannelIds, enabled, or mode.',
          );
        }

        const updated = await guild.editOnboarding(editOptions);

        const structured = toOnboardingConfigOutput(updated);
        const text = `Onboarding updated in ${guild.name}.\n${toOnboardingText(guild, structured)}`;

        return okResult(structured, text);
      } catch (error) {
        return errorResult(toFriendlyError(error, 'Failed to update onboarding:'));
      }
    },
  );
}