# opencode-plugin-mempalace

Persistent cross-project memory for [opencode](https://opencode.ai) via [MemPalace](https://github.com/alfarihfz/mempalace).

Automatically mines conversations and project files into a semantic memory palace, injects recall rules into the agent system prompt, and ensures critical context survives compaction — all without manual intervention.

## What It Does

- **Conversation mining** — Exports session messages from opencode's SQLite DB and feeds them to `mempalace mine --mode convos`
- **Project mining** — Mines the active project directory (`--mode projects`) on compaction events
- **System prompt injection** — Injects 7 mandatory recall rules into every session's system prompt, ensuring the agent always searches mempalace before saying "I don't know"
- **Pre-compaction persistence** — Before context compaction, prompts the agent to write diary entries and save high-value findings as drawers
- **Concurrency safety** — Global file-based lock prevents mine storms across concurrent sessions
- **Mine target safety** — Blocklist prevents mining `/`, homedir, `/tmp`, or any path with < 3 segments

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    opencode session                       │
├──────────────┬──────────────────┬────────────────────────┤
│  session.idle│  compacting      │  system.transform      │
│  (event hook)│  (pre-compact)   │  (prompt injection)    │
└──────┬───────┴────────┬─────────┴───────────┬────────────┘
       │                │                     │
       ▼                ▼                     ▼
  Export convo     Mine projects +       Inject 7 recall
  from SQLite →    convos (sync) →       rules into system
  mine convos      diary reminder        prompt array
  (background)
       │                │
       ▼                ▼
  ┌─────────────────────────┐
  │   Global file lock      │
  │  (~/.mempalace/hook_    │
  │   state/mine.lock)      │
  └────────────┬────────────┘
               ▼
  ┌─────────────────────────┐
  │   mempalace CLI         │
  │   (mine convos/projects)│
  └─────────────────────────┘
```

### Hooks

| Hook | Trigger | Action | Sync |
|------|---------|--------|------|
| `event` (`session.idle`) | Every N user messages | Export session → mine convos | Background |
| `experimental.session.compacting` | Before context compaction | Mine projects + convos, inject diary reminder | Synchronous |
| `experimental.chat.system.transform` | Every request | Inject recall rules into system prompt | Synchronous |

### Safety Mechanisms

- **Global lock** (`mine.lock`) — Only one mine operation runs at a time across all sessions. Stale locks (> 5 min) are auto-removed.
- **Mine blocklist** — Blocks: `/`, `/home`, `/tmp`, `/var`, `/etc`, `/usr`, `/root`, `/opt`, `/bin`, `/sbin`, homedir, and any path with < 3 segments.
- **Worktree fallback** — In web mode, `worktree` is often `/`. The plugin cascades: `MEMPAL_DIR` → `worktree` → `directory`, skipping unsafe values at each level.

## Install

### Option A: Local file (auto-load, recommended)

Build and copy the output directly:

```bash
cd /path/to/opencode-mempalace-plugin/opencode-plugin-mempalace
bun install
bun run build
cp dist/index.js ~/.config/opencode/plugins/mempalace.js
```

opencode auto-loads all `.js` files from `~/.config/opencode/plugins/`.

### Option B: Registered plugin

Add as a local dependency in `~/.config/opencode/package.json`:

```json
{
  "dependencies": {
    "opencode-plugin-mempalace": "file:./plugins-src/opencode-plugin-mempalace"
  }
}
```

Register in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-plugin-mempalace"]
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMPAL_SAVE_INTERVAL` | `15` | User messages between automatic saves |
| `MEMPAL_DIR` | (auto-detect) | Override project directory for `--mode projects` mining |
| `MEMPAL_BIN` | `mempalace` | Path to the mempalace CLI binary |
| `MEMPAL_VERBOSE` | (unset) | `true`/`1` — log diary-save prompts to opencode app log |
| `MEMPAL_STATE_DIR` | `~/.mempalace/hook_state` | Directory for hook state (lock, counters, exports) |
| `MEMPAL_DISABLED` | (unset) | `true`/`1` — disable the plugin entirely |
| `MEMPAL_MINE_CONVOS` | (enabled) | `false`/`0` — skip conversation mining |

## Build

```bash
cd opencode-plugin-mempalace
bun install
bun run build
```

Output: `dist/index.js`

### Deploy to opencode

```bash
cp dist/index.js ~/.config/opencode/plugins/mempalace.js
```

## How It Works

### 1. Conversation Export

On each save trigger, the plugin opens opencode's SQLite database (`~/.local/share/opencode/opencode.db`), queries messages for the active session, and writes them as a markdown file to `~/.mempalace/hook_state/convos_export/`. This file is then fed to `mempalace mine <dir> --mode convos`.

### 2. System Prompt Injection

Every request gets 7 mandatory rules appended to the system prompt array, ensuring the agent:
- Searches mempalace before claiming ignorance
- Searches on any error/failure (to recall past solutions)
- Proactively recalls preferences for common operations (git, docker, SSH, deploy)

### 3. Pre-Compaction

Before opencode compacts context, the plugin:
1. Synchronously mines the project directory (`--mode projects`)
2. Synchronously mines the current conversation
3. Injects a reminder into the compaction context asking the agent to write diary entries and save high-value findings

## Dependencies

- **Runtime**: [Bun](https://bun.sh/) (uses `bun:sqlite` for DB access, `Bun.$` shell for CLI invocation)
- **Peer**: `@opencode-ai/plugin` ^1.4.6
- **External**: `mempalace` CLI must be available in PATH (or set `MEMPAL_BIN`)

## License

MIT
