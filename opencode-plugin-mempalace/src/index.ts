/**
 * opencode-plugin-mempalace — Auto-save plugin for MemPalace.
 *
 * Hooks:
 *   session.idle  — every N user messages: export & mine conversations only (lightweight)
 *   compacting    — before context compaction: mine projects + convos sync + diary reminder
 *
 * Concurrency: Global file-based lock prevents multiple mine operations from running
 * simultaneously across sessions. If a mine is already in progress, new requests are skipped.
 *
 * Env vars:
 *   MEMPAL_SAVE_INTERVAL  — messages between saves (default: 15)
 *   MEMPAL_DIR            — override project dir to mine (default: auto-detect from session)
 *   MEMPAL_BIN            — mempalace CLI path (default: "mempalace")
 *   MEMPAL_VERBOSE        — "true"/"1" to inject diary-save prompt on each save
 *   MEMPAL_STATE_DIR      — hook state dir (default: ~/.mempalace/hook_state)
 *   MEMPAL_DISABLED       — "true"/"1" to disable the plugin entirely
 *   MEMPAL_MINE_CONVOS    — "false"/"0" to skip conversation mining (default: enabled)
 */

import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { Database } from "bun:sqlite"

type BunShell = PluginInput["$"]

const SAVE_INTERVAL = parseInt(process.env.MEMPAL_SAVE_INTERVAL ?? "15", 10)
const MEMPAL_DIR = process.env.MEMPAL_DIR ?? ""
const MEMPAL_BIN = process.env.MEMPAL_BIN ?? "mempalace"
const MEMPAL_VERBOSE = ["true", "1"].includes((process.env.MEMPAL_VERBOSE ?? "").toLowerCase())
const MEMPAL_DISABLED = ["true", "1"].includes((process.env.MEMPAL_DISABLED ?? "").toLowerCase())
const MINE_CONVOS = !["false", "0"].includes((process.env.MEMPAL_MINE_CONVOS ?? "").toLowerCase())
const STATE_DIR = process.env.MEMPAL_STATE_DIR ?? join(homedir(), ".mempalace", "hook_state")

const LOG_FILE = join(STATE_DIR, "hook.log")
const CONVOS_DIR = join(STATE_DIR, "convos_export")
const OC_DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db")
const SESSION_ID_SAFE_RE = /[^a-zA-Z0-9_-]/g
const DIGITS_ONLY_RE = /^\d+$/
const LOCK_FILE = join(STATE_DIR, "mine.lock")
const LOCK_STALE_MS = 5 * 60 * 1000 // 5 minutes — consider lock stale after this

/**
 * File-based global lock to prevent concurrent mining.
 * Returns true if lock acquired, false if another mine is in progress.
 */
function acquireLock(context: string): boolean {
  try {
    ensureDir(STATE_DIR)
    if (existsSync(LOCK_FILE)) {
      const stat = readFileSync(LOCK_FILE, "utf8").trim()
      const [timestamp] = stat.split("|")
      const lockAge = Date.now() - parseInt(timestamp || "0", 10)
      if (lockAge < LOCK_STALE_MS) {
        log(`lock: BLOCKED by existing lock (age=${Math.round(lockAge / 1000)}s ctx=${stat.split("|")[1] ?? "?"})`)
        return false
      }
      log(`lock: stale lock removed (age=${Math.round(lockAge / 1000)}s)`)
    }
    writeFileSync(LOCK_FILE, `${Date.now()}|${context}`)
    return true
  } catch {
    return false
  }
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE)
  } catch {
    /* best-effort */
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function log(message: string): void {
  try {
    ensureDir(STATE_DIR)
    appendFileSync(LOG_FILE, `[${new Date().toTimeString().slice(0, 8)}] ${message}\n`)
  } catch {
    /* logging must never break the plugin */
  }
}

function lastSaveFile(sessionId: string): string {
  return join(STATE_DIR, `${sessionId.replace(SESSION_ID_SAFE_RE, "_")}_last_save`)
}

function readLastSave(sessionId: string): number {
  try {
    const path = lastSaveFile(sessionId)
    if (!existsSync(path)) return 0
    const raw = readFileSync(path, "utf8").trim()
    return DIGITS_ONLY_RE.test(raw) ? parseInt(raw, 10) : 0
  } catch {
    return 0
  }
}

function writeLastSave(sessionId: string, count: number): void {
  try {
    ensureDir(STATE_DIR)
    writeFileSync(lastSaveFile(sessionId), String(count))
  } catch {
    /* best-effort */
  }
}

const humanMessageCounts = new Map<string, number>()

function incrementHumanMessages(sessionId: string): number {
  const next = (humanMessageCounts.get(sessionId) ?? 0) + 1
  humanMessageCounts.set(sessionId, next)
  return next
}

/**
 * Export a session's conversation from opencode.db to a markdown file
 * compatible with mempalace's convo_miner (exchange pair format).
 *
 * Returns the path to the exported file, or null if nothing to export.
 */
function exportSessionConvo(sessionId: string): string | null {
  if (!existsSync(OC_DB_PATH)) {
    log(`convos: opencode.db not found at ${OC_DB_PATH}`)
    return null
  }

  let db: InstanceType<typeof Database> | null = null
  try {
    db = new Database(OC_DB_PATH, { readonly: true })

    const session = db
      .query<{ directory: string | null }, [string]>("SELECT directory FROM session WHERE id = ?")
      .get(sessionId)
    const projectName = session?.directory ? basename(session.directory) : "unknown"

    const rows = db
      .query<
        { role: string; text: string; time_created: string },
        [string]
      >(
        `SELECT
           json_extract(m.data, '$.role') AS role,
           json_extract(p.data, '$.text') AS text,
           m.time_created
         FROM message m
         JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
         WHERE m.session_id = ?
           AND json_extract(p.data, '$.type') = 'text'
           AND json_extract(p.data, '$.text') IS NOT NULL
         ORDER BY m.time_created ASC, p.id ASC`,
      )
      .all(sessionId)

    if (rows.length === 0) {
      log(`convos: no messages for session ${sessionId}`)
      return null
    }

    const lines: string[] = [
      `# Session: ${sessionId}`,
      `# Project: ${projectName}`,
      `# Exported: ${new Date().toISOString()}`,
      "",
    ]

    for (const row of rows) {
      const text = (row.text ?? "").trim()
      if (!text) continue
      if (row.role === "user") {
        lines.push(`> ${text.replace(/\n/g, "\n> ")}`)
      } else {
        lines.push(text)
      }
      lines.push("")
    }

    ensureDir(CONVOS_DIR)
    const safeId = sessionId.replace(SESSION_ID_SAFE_RE, "_")
    const outPath = join(CONVOS_DIR, `${safeId}.md`)
    writeFileSync(outPath, lines.join("\n"), "utf8")
    log(`convos: exported ${rows.length} parts → ${outPath}`)
    return outPath
  } catch (err) {
    log(`convos: export failed for ${sessionId}: ${(err as Error).message}`)
    return null
  } finally {
    try { db?.close() } catch { /* safe close */ }
  }
}

async function mineConversation(
  $: BunShell,
  sessionId: string,
  synchronous: boolean,
): Promise<void> {
  if (!MINE_CONVOS) return

  const exported = exportSessionConvo(sessionId)
  if (!exported) return

  if (!acquireLock(`convos:${sessionId}`)) return

  log(`mining convos: ${exported}${synchronous ? " (sync)" : " (bg)"}`)
  const runner = async () => {
    try {
      await $`${MEMPAL_BIN} mine ${CONVOS_DIR} --mode convos`.quiet()
      log(`mined convos: ${CONVOS_DIR}`)
    } catch (err) {
      log(`mine convos failed: ${(err as Error).message}`)
    } finally {
      releaseLock()
    }
  }
  if (synchronous) await runner()
  else runner().catch(() => {})
}

const MINE_BLOCKLIST = new Set(["/", "/home", "/tmp", "/var", "/etc", "/usr", "/root", "/opt", "/bin", "/sbin"])

function isSafeMineTarget(dir: string): boolean {
  const resolved = dir.replace(/\/+$/, "") || "/"
  if (MINE_BLOCKLIST.has(resolved)) return false
  if (resolved === homedir()) return false
  // Reject paths with fewer than 3 segments (e.g. /home/user)
  const segments = resolved.split("/").filter(Boolean)
  if (segments.length < 3) return false
  return true
}

async function mineDirectory(
  $: BunShell,
  dir: string,
  mode: "convos" | "projects",
  synchronous: boolean,
): Promise<void> {
  if (!isSafeMineTarget(dir)) {
    log(`BLOCKED mine (unsafe target): ${dir}`)
    return
  }

  if (!existsSync(dir)) {
    log(`skip mine (missing dir): ${dir}`)
    return
  }

  if (!acquireLock(`${mode}:${dir}`)) return

  log(`mining ${mode}: ${dir}${synchronous ? " (sync)" : " (bg)"}`)
  const runner = async () => {
    try {
      await $`${MEMPAL_BIN} mine ${dir} --mode ${mode}`.quiet()
      log(`mined ${mode}: ${dir}`)
    } catch (err) {
      log(`mine failed [${mode}] ${dir}: ${(err as Error).message}`)
    } finally {
      releaseLock()
    }
  }
  if (synchronous) await runner()
  else runner().catch(() => {})
}

const SYSTEM_PROMPT_INJECTION = [
  "## Cross-Project Memory (MemPalace) — MANDATORY",
  "",
  "You have access to a cross-project memory system via the `mempalace_search` MCP tool.",
  "It contains 600K+ drawers of knowledge from ALL projects the user works on,",
  "including past conversations, architecture decisions, config fixes, and project files.",
  "",
  "**RULES (non-negotiable):**",
  "",
  "1. If the user mentions ANY project name, tool, or concept you don't immediately",
  '   recognize in the current codebase — call `mempalace_search` BEFORE saying',
  '   "I don\'t know" or asking for clarification.',
  "2. If the user asks about past work, decisions, or history — call `mempalace_search`.",
  "3. On session start, if context is unclear, search mempalace for recent project activity.",
  "4. Never tell the user something doesn't exist without first searching mempalace.",
  '5. If the user asks "what did we do about X" or "what about X" — ALWAYS search',
  "   mempalace even if you have local context. The user may be asking about a",
  "   DIFFERENT PROJECT entirely, not just this session's work.",
  "6. **ON ANY ERROR OR FAILURE** — before debugging from scratch, search mempalace for",
  "   the error message, the tool/command that failed, or the concept involved. The user",
  "   may have already solved this exact problem in another project or session.",
  "   Examples: SSH auth failure → search for SSH config/agent. Git push rejected →",
  "   search for git push workaround. Build failure → search for that build tool.",
  "7. **PROACTIVE RECALL** — when performing common operations (git push, deploy, SSH,",
  "   docker, env setup), search mempalace for the user's known preferences/configs",
  "   BEFORE attempting. The user likely has established patterns stored in memory.",
  "",
  "**Available MCP tools:** mempalace_search, mempalace_add_drawer, mempalace_diary_write,",
  "mempalace_diary_read, mempalace_kg_query, mempalace_status",
  "",
  "**Example searches:**",
  '- User asks "what about dial?" → mempalace_search(query="dial project")',
  '- User asks "what did we decide about auth?" → mempalace_search(query="authentication decision")',
  '- User mentions unfamiliar term → mempalace_search(query="<that term>")',
  '- User asks "what we do about Microfrontend Host?" → mempalace_search(query="microfrontend host")',
  '- SSH auth fails → mempalace_search(query="SSH agent sock config")',
  '- Git push rejected → mempalace_search(query="git push authentication")',
  '- Docker fails → mempalace_search(query="docker setup configuration")',
  '- Unknown env var needed → mempalace_search(query="environment variable <name>")',
  '- User says "push this" → mempalace_search(query="git push method") to recall preferences',
  "",
  "The memory palace is GLOBAL — it knows about all projects across all sessions.",
  "The user expects you to REMEMBER solutions from other projects without being told twice.",
].join("\n")

const PRECOMPACT_REMINDER = [
  "## MemPalace — Save Before Compaction",
  "",
  "CRITICAL: Before this session is compacted, persist anything that must survive:",
  "",
  '1. Write a diary entry via `mempalace_diary_write` (agent_name="sisyphus") summarizing:',
  "   - Key topics discussed",
  "   - Decisions made (with reasoning)",
  "   - Verbatim quotes of user preferences / constraints",
  "   - Files/paths materially changed",
  "2. Save high-value findings as drawers via `mempalace_add_drawer`:",
  '   - Architecture decisions → room="decisions"',
  '   - Bug root causes → room="debugging"',
  '   - Setup/config that took effort → room="setup"',
  '3. If the conversation established new user preferences, save to wing="user_prefs".',
  "",
  "After saving, continue with the normal compaction summary.",
].join("\n")

const SAVE_DIARY_PROMPT =
  "MemPalace save checkpoint. Write a brief session diary entry via " +
  "`mempalace_diary_write` covering key topics, decisions, and verbatim " +
  "quotes since the last save. Continue after saving."

export const MempalacePlugin: Plugin = async ({ $, client, directory, worktree }) => {
  if (MEMPAL_DISABLED) {
    log("plugin disabled via MEMPAL_DISABLED")
    return {}
  }

  // Resolve mine target with safety checks at each fallback level.
  // worktree is often "/" in web mode — skip unsafe values and try directory instead.
  const mineTarget = (() => {
    if (MEMPAL_DIR && isSafeMineTarget(MEMPAL_DIR)) return MEMPAL_DIR
    if (worktree && isSafeMineTarget(worktree)) return worktree
    if (directory && isSafeMineTarget(directory)) return directory
    return ""
  })()

  log(
    `loaded interval=${SAVE_INTERVAL} dir=${directory} worktree=${worktree ?? "n/a"} ` +
      `mine_target=${mineTarget || "(none)"} verbose=${MEMPAL_VERBOSE} convos=${MINE_CONVOS}`,
  )

  const handleEvent = async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
    try {
      if (event.type === "message.updated") {
        const props = event.properties ?? {}
        const info = (props.info ?? props.message ?? {}) as Record<string, unknown>
        const role = (info.role as string) ?? (props.role as string)
        if (role === "user") {
          const sessionId = (props.sessionID as string) ?? (info.sessionID as string) ?? "unknown"
          incrementHumanMessages(sessionId)
        }
        return
      }

      if (event.type === "session.idle") {
        const props = event.properties ?? {}
        const sessionId = (props.sessionID as string) ?? "unknown"
        const exchanges = humanMessageCounts.get(sessionId) ?? 0
        const lastSave = readLastSave(sessionId)
        const since = exchanges - lastSave

        log(`idle session=${sessionId} exchanges=${exchanges} since=${since}`)

        if (since >= SAVE_INTERVAL && exchanges > 0) {
          writeLastSave(sessionId, exchanges)
          log(`TRIGGER SAVE at exchange ${exchanges}`)

          // Only convos here — project mining deferred to compaction (avoids concurrent CPU spikes)
          await mineConversation($, sessionId, false)

          if (MEMPAL_VERBOSE) {
            try {
              await client.app.log({
                body: { service: "mempalace", level: "info", message: SAVE_DIARY_PROMPT },
              })
            } catch {
              /* logging is optional */
            }
          }
        }
        return
      }
    } catch (err) {
      log(`event handler error: ${(err as Error).message}`)
    }
  }

  const onCompacting = async (
    input: { sessionID?: string } | undefined,
    output: { context?: string[]; prompt?: string },
  ) => {
    const sessionId = input?.sessionID ?? "unknown"
    log(`PRE-COMPACT triggered session=${sessionId}`)

    if (mineTarget) {
      await mineDirectory($, mineTarget, "projects", true)
    }

    await mineConversation($, sessionId, true)

    if (Array.isArray(output.context)) {
      output.context.push(PRECOMPACT_REMINDER)
    }
  }

  const onSystemTransform = async (
    _input: { sessionID?: string; model?: unknown },
    output: { system: string[] },
  ) => {
    if (Array.isArray(output.system)) {
      output.system.push(SYSTEM_PROMPT_INJECTION)
    }
  }

  return {
    event: handleEvent,
    "experimental.chat.system.transform": onSystemTransform,
    "experimental.session.compacting": onCompacting,
  } satisfies Hooks
}

export default MempalacePlugin
