export * as ClaudeAccounts from "./accounts.js"

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Option, Schema } from "effect"
import { ClaudeAgentError } from "../language-model/claude-agent-error.js"
import type { ClaudeSessions } from "./sessions.js"

export interface Storage {
  readonly get: (key: string) => Effect.Effect<unknown>
  readonly set: (key: string, value: string) => Effect.Effect<void>
}

export interface Interface {
  readonly run: (request: ClaudeSessions.Request, configDirs: readonly string[]) => Effect.Effect<void, Error>
}

const LAST = "last-account"

// Weekly Opus and Sonnet limits only stop that model family. Every other limit stops the whole account.
const FAMILY = { seven_day_opus: "opus", seven_day_sonnet: "sonnet" } as const

function family(model: string) {
  return Object.values(FAMILY).find((name) => model.toLowerCase().includes(name))
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

  const remember = (dir: string, error: ClaudeAgentError.Failure) => {
    if (!error.resetsAt) return
    const kind = FAMILY[error.limitType as keyof typeof FAMILY] as string | undefined
    limited.set(kind ? `${dir}\n${kind}` : dir, error.resetsAt)
  }

  const read = Effect.fn("ClaudeAccounts.read")(function* (key: string) {
    return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(yield* input.storage.get(key)))
  })

  const run = Effect.fn("ClaudeAccounts.run")(function* (
    request: ClaudeSessions.Request,
    configDirs: readonly string[],
  ) {
    const connection = request.connection
    // An API key or token logs in the same way whatever the folder, so those requests never rotate.
    if (configDirs.length < 2 || connection?.ANTHROPIC_API_KEY || connection?.ANTHROPIC_AUTH_TOKEN) {
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
      return yield* Effect.fail(
        ClaudeAgentError.quota(
          `Every Claude account is at its usage limit. The first resets at ${new Date(next).toISOString()}.`,
        ),
      )
    }
    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i]
      const attempt = watch(request.emit)
      yield* input.sessions.run({
        ...request,
        connection: { ...connection, CLAUDE_CONFIG_DIR: dir },
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
      if (error.limited) remember(dir, error)
      // Only a limit is worth another account. A retry after Claude has shown output would repeat that output.
      if (!error.limited || attempt.shown() || i === dirs.length - 1) {
        attempt.flush()
        return
      }
      yield* Effect.logInfo("Claude account refused the request, retrying on the next one", {
        from: dir,
        to: dirs[i + 1],
      })
    }
  })

  return { run } satisfies Interface
}

function watch(emit: (message: SDKMessage) => void) {
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
