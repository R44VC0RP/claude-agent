// Prints each Claude account's plan limits as JSON, for the menu bar app. No prompt is sent, so no tokens are used.
// Accounts are the folders given as arguments, else `configDir` in the global opencode.json, else the default login.
import { query } from "@anthropic-ai/claude-agent-sdk"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import which from "which"
import { ClaudeQueryOptions } from "../src/claude/query-options.js"

interface Limit {
  // The window's name in Claude Code's usage data, such as five_hour. Model windows are `model:<name>`.
  id: string
  label: string
  percent: number
  resetsAt?: string
}

interface Account {
  // Absent for the default login in ~/.claude
  dir?: string
  email?: string
  plan?: string
  limits: Limit[]
  error?: string
}

const TIMEOUT_MS = 30_000

async function configured() {
  const root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  const text = await readFile(path.join(root, "opencode", "opencode.json"), "utf8").catch(() => undefined)
  if (!text) return []
  try {
    return ClaudeQueryOptions.configDirs(JSON.parse(text)?.providers?.["claude-agent"]?.settings?.configDir)
  } catch {
    return []
  }
}

async function read(executable: string, dir: string | undefined): Promise<Account> {
  const stop = Promise.withResolvers<void>()
  async function* idle(): AsyncGenerator<never> {
    await stop.promise
  }
  const session = query({
    prompt: idle(),
    options: {
      pathToClaudeCodeExecutable: executable,
      env: { ...process.env, ...ClaudeQueryOptions.configEnv(dir) },
      settingSources: [],
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      skills: [],
      tools: [],
      persistSession: false,
    },
  })
  try {
    const account = (await session.initializationResult()).account
    const identity = { dir, email: account.email, plan: account.subscriptionType }
    if (account.tokenSource === "none" && account.apiKeySource === undefined) {
      const login = dir ? `CLAUDE_CONFIG_DIR="${dir}" claude auth login` : "claude auth login"
      return { ...identity, limits: [], error: `Not logged in. Run: ${login}` }
    }
    const usage = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
    const rates = usage.rate_limits
    if (!usage.rate_limits_available || !rates) {
      return { ...identity, limits: [], error: "This login has no plan limits (API key or cloud provider)." }
    }
    const limits = new Map<string, Limit>()
    const add = (
      id: string,
      label: string,
      window?: { utilization: number | null; resets_at: string | null } | null,
    ) => {
      if (!window || window.utilization === null) return
      const resetsAt = window.resets_at ? new Date(window.resets_at).toISOString() : undefined
      limits.set(label, { id, label, percent: window.utilization, resetsAt })
    }
    add("five_hour", "5-hour", rates.five_hour)
    add("seven_day", "Weekly", rates.seven_day)
    add("seven_day_opus", "Weekly Opus", rates.seven_day_opus)
    add("seven_day_sonnet", "Weekly Sonnet", rates.seven_day_sonnet)
    for (const scoped of rates.model_scoped ?? []) {
      add(`model:${scoped.display_name}`, `Weekly ${scoped.display_name}`, scoped)
    }
    return { ...identity, limits: [...limits.values()] }
  } finally {
    stop.resolve()
    session.close()
  }
}

async function account(executable: string, dir: string | undefined): Promise<Account> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Claude Code did not answer within 30 seconds")), TIMEOUT_MS),
  )
  return Promise.race([read(executable, dir), timeout]).catch((error) => ({
    dir,
    limits: [],
    error: error instanceof Error ? error.message : String(error),
  }))
}

const executable = process.env.OPENCODE_CLAUDE_PATH || which.sync("claude", { nothrow: true })
if (!executable) {
  console.log(JSON.stringify({ accounts: [], error: "Claude Code is not installed." }))
  process.exit(0)
}
const given = ClaudeQueryOptions.configDirs(process.argv.slice(2))
// ~/.claude is the usual login, which has no folder of its own to name.
const dirs = (given.length > 0 ? given : await configured()).map(
  (dir) => ClaudeQueryOptions.configEnv(dir).CLAUDE_CONFIG_DIR,
)
if (dirs.length === 0) dirs.push(undefined)
console.log(JSON.stringify({ accounts: await Promise.all(dirs.map((dir) => account(executable, dir))) }))
process.exit(0)
