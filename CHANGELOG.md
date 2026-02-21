# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-01-28

### Added

- Core agent system with state machine architecture (idle → thinking → acting → observing → reflecting)
- Three-tiered cognitive memory system (system2, working, system1) with configurable decay rates
- Journal manager for chronological logging with typed entries (thought, action, observation, reflection, decision, error, milestone)
- Tools framework with JSON Schema validation and dynamic handler dispatch
- Background scheduler with cron-based tasks for memory decay, cleanup, and consolidation
- Persistent task queue with retry and backoff support
- Daemon process with IPC via JSON-RPC 2.0 over Unix sockets
- File watcher for directory monitoring that triggers agent actions
- LLM provider integrations: OpenAI, Anthropic Claude, Ollama (local), Mock (testing)
- Embedding providers (1536-dim vectors): OpenAI, Voyage, Ollama, Mock
- React-based TUI using Ink framework with dashboard, chat, journal, memory, and tasks views
- CLI interface for agent interaction and management
- TursoDB/libSQL persistence with vector embedding support

[Unreleased]: https://github.com/username/kronk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/username/kronk/releases/tag/v0.1.0
