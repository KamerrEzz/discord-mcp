# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-09-06

### Added

- MCP server over stdio transport in TypeScript, powered by discord.js v14 and the official MCP TypeScript SDK
- Server read tools: guild summary, roles (list and detail), hierarchical channel listing, channel detail, paginated message history, and member lookups
- Announcement tools: embed announcements with title, body, brand color, fields, image, thumbnail, and optional role or @everyone ping; plain messages with optional reply support
- Role management: create, update, delete, assign and unassign roles, and reorder the role hierarchy
- Channel management: create channels (text, voice, announcement, forum, category), update, delete, and move channels between categories
- Confirmation gates on every write tool: normal writes require `confirm: true`, destructive or high-visibility actions require the literal `confirm: "YES"`
- Setup guide with Discord Developer Portal steps, privileged intents, invite URL, and tool reference in the README

[Unreleased]: https://github.com/KamerrEzz/discord-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/KamerrEzz/discord-mcp/releases/tag/v1.0.0