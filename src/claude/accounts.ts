export * as ClaudeAccounts from "./accounts.js"

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Option, Schema } from "effect"
import { ClaudeAgentError } from "../language-model/claude-agent-error.js"
import { ClaudeQueryOptions } from "./query-options.js"
import type { ClaudeSessions } from "./sessions.js"

export interface Storage {
  readonly get: (key: string) => Effect.Effect<unknown>
  readonly set: (key: string, value: string) => Effect.Effect<void>
}

export interface Interface {
  readonly run: (request: ClaudeSessions.Request, configDirs: readonly string[]) => Effect.Effect<void, Error>
  // When a chat that a usage limit just stopped can carry on, in epoch milliseconds: now if another account is
  // free, else when the first account's limit resets. Undefined when its last request did not stop at a limit.
  // Reading it clears it, so it only answers for the failure that was just reported.
  readonly resumeAt: (sessionID: string) => number | undefined
}

const LAST = "last-account"

// Only the 5-hour limit is known to stop every model. A weekly limit can belong to one model family (Opus, Sonnet,
// or a newer one such as Fable, which Claude Code reports without naming it), so it only stops the family that hit it.
// If it does cover every model, each other family finds that out with one refused request of its own.
function family(model: string) {
  return /opus|sonnet|haiku|fable|mythos/.exec(model.toLowerCase())?.[0]
}

export function make(input: { readonly sessions: ClaudeSessions.Interface; readonly storage: Storage }) {
  // Accounts at a limit, keyed by folder or by folder and model family, until the limit resets.
  // Kept in memory, so a burst of subagents skips a spent account instead of starting Claude on it.
  const limited = new Map<string, number>()

  const until = (dir: string, model: string) => {
    const kind = family(model)
    const resets = [limited.get(dir), kind ? limited.get(`${dir}\n${kind}`) : undefined]
    const time = Date.now()
    const active = resets.filter((reset): reset is number => reset !== undefined && reset > time)
    return active.length ? Math.max(...active) : undefined
  }

  const waiting = new Map<string, number>()

  // Called when a request ends at a limit. `refused` are the accounts that refused this request.
  const wait = (request: ClaudeSessions.Request, configDirs: readonly string[], refused: ReadonlySet<string>) => {
    const chat = request.sessionID ?? request.sourceID
    if (!chat) return
    const resets = configDirs.map((dir) => until(dir, request.model))
    if (configDirs.some((dir, index) => resets[index] === undefined && !refused.has(dir))) {
      waiting.set(chat, Date.now())
      return
    }
    // An account that refused without saying when it resets gives nothing to wait for.
    if (resets.some((reset) => reset === undefined)) return
    waiting.set(chat, Math.min(...(resets as number[])))
  }

  const remember = (dir: string, model: string, error: ClaudeAgentError.Failure) => {
    if (!error.resetsAt) return
    // seven_day_opus and seven_day_sonnet name their family, whichever model the request used.
    const named = /opus|sonnet/.exec(error.limitType ?? "")?.[0]
    const kind = error.limitType === "five_hour" ? undefined : (named ?? family(model))
    limited.set(kind ? `${dir}\n${kind}` : dir, error.resetsAt)
  }

  const read = Effect.fn("ClaudeAccounts.read")(function* (key: string) {
    return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(yield* input.storage.get(key)))
  })

  const run = Effect.fn("ClaudeAccounts.run")(function* (
    request: ClaudeSessions.Request,
    configDirs: readonly string[],
  ) {
    // Only this request's own outcome says whether its chat is waiting on a limit.
    const chat = request.sessionID ?? request.sourceID
    if (chat) waiting.delete(chat)
    // The login check's folder, the first one, is replaced by each attempt's own.
    const { CLAUDE_CONFIG_DIR: _, ...connection } = request.connection ?? {}
    // An API key or token logs in the same way whatever the folder, so those requests never rotate.
    if (configDirs.length < 2 || connection.ANTHROPIC_API_KEY || connection.ANTHROPIC_AUTH_TOKEN) {
      return yield* input.sessions.run(request)
    }
    const own = request.sessionID ? yield* read(`accounts/${request.sessionID}`) : undefined
    const last = yield* read(LAST)
    // Side calls and new forks start on their parent chat's account, which has its transcript and prompt cache.
    const parent = !own && request.sourceID ? yield* read(`accounts/${request.sourceID}`) : undefined
    const from = own ?? parent ?? last
    const start = from ? Math.max(0, configDirs.indexOf(from)) : 0
    const order = [...configDirs.slice(start), ...configDirs.slice(0, start)]
    const dirs = order.filter((dir) => until(dir, request.model) === undefined)
    if (dirs.length === 0) {
      const next = Math.min(...order.map((dir) => until(dir, request.model)!))
      wait(request, configDirs, new Set())
      return yield* Effect.fail(
        ClaudeAgentError.quota(
          `Every Claude account is at its usage limit. The first resets at ${new Date(next).toISOString()}.`,
        ),
      )
    }
    const refused = new Set<string>()
    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i]
      const limit = (error: ClaudeAgentError.Failure) => {
        remember(dir, request.model, error)
        refused.add(dir)
      }
      // OpenCode asks whether to retry as soon as it is handed the failure, which for a reply already shown is
      // before this request returns. So that chat's wait is settled first.
      const attempt = watch(request.emit, (error) => {
        if (!error.limited) return
        limit(error)
        wait(request, configDirs, refused)
      })
      yield* input.sessions.run({
        ...request,
        connection: { ...connection, ...ClaudeQueryOptions.configEnv(dir) },
        emit: attempt.emit,
      })
      const error = attempt.error()
      if (!error) {
        // A side call never moves its chat, because the side call's model may have hit a limit of its own.
        if (request.sessionID && dir !== own) yield* input.storage.set(`accounts/${request.sessionID}`, dir)
        if (dir !== last) yield* input.storage.set(LAST, dir)
        attempt.flush()
        return
      }
      if (error.limited) limit(error)
      // Only a limit is worth another account. A retry after Claude has shown output would repeat that output,
      // so that one is left to OpenCode, which continues the chat in a new step.
      if (!error.limited || attempt.shown() || i === dirs.length - 1) {
        if (error.limited && !attempt.shown()) wait(request, configDirs, refused)
        attempt.flush()
        return
      }
      yield* Effect.logInfo("Claude account refused the request, retrying on the next one", {
        from: dir,
        to: dirs[i + 1],
      })
    }
  })

  const resumeAt = (sessionID: string) => {
    const at = waiting.get(sessionID)
    waiting.delete(sessionID)
    return at
  }

  return { run, resumeAt } satisfies Interface
}

// `failedShown` runs when a reply that was already shown fails, before the failure is passed on.
function watch(emit: (message: SDKMessage) => void, failedShown: (error: ClaudeAgentError.Failure) => void) {
  const failure = ClaudeAgentError.make()
  let held: SDKMessage[] | undefined = []
  let error: ClaudeAgentError.Failure | undefined

  const flush = () => {
    if (!held) return
    const messages = held
    held = undefined
    for (const message of messages) emit(message)
  }

  return {
    emit(message: SDKMessage) {
      const failed = failure(message)
      if (failed) error = failed
      if (!held) {
        if (failed) failedShown(failed)
        emit(message)
        return
      }
      const visible = message.type === "stream_event" || (message.type === "assistant" && !message.error)
      if (!visible) {
        held.push(message)
        return
      }
      flush()
      emit(message)
    },
    flush,
    shown: () => held === undefined,
    error: () => error,
  }
}
