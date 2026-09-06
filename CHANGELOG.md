# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.1] - 2026-09-06

### Fixed

- Onboarding description validation: enforce the Discord API 100-character limit on option descriptions (longer ones were rejected with error 50035)

## [1.1.0] - 2026-09-06

### Added

- Onboarding tools: read the full guild onboarding configuration (enabled, mode, default channels, prompts and every option with its assigned roles, channels, and emoji) and update it with human confirmation, including editing prompts, options, default channels, the enabled flag, and the onboarding mode
- Onboarding updates are FULL REPLACEMENT for the prompt and default-channel lists, documented in the tool contract so nothing is silently dropped

### Fixed

- Environment loading: `.env` is now resolved from the project root instead of the process working directory, so the server starts from any directory

[Unreleased]: https://github.com/KamerrEzz/discord-mcp/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/KamerrEzz/discord-mcp/releases/tag/v1.1.1
[1.1.0]: https://github.com/KamerrEzz/discord-mcp/releases/tag/v1.1.0
[1.0.0]: https://github.com/KamerrEzz/discord-mcp/releases/tag/v1.0.0