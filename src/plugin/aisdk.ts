export * as ClaudeAISDK from "./aisdk.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import type { ClaudeAccounts } from "../claude/accounts.js"
import { ClaudeQueryOptions } from "../claude/query-options.js"
import { ClaudeAgentLanguageModel } from "../language-model/claude-agent-language-model.js"
import { ClaudeProvider } from "./provider.js"

type Runner = (
  request: Parameters<ClaudeAccounts.Interface["run"]>[0],
  configDirs: readonly string[],
  signal?: AbortSignal,
) => Promise<void>

// OpenCode keeps each model's SDK for the life of its location, also across a reload of this plugin, so a model used
// before the reload would keep calling the unloaded plugin, whose Claude processes and fixes are gone. Each SDK
// therefore runs requests through the newest loaded plugin for its location. The table lives on globalThis because a
// reload imports this module again.
const runners: Map<string, Runner> = ((globalThis as Record<symbol, unknown>)[
  Symbol.for("opencode.claude-agent.runners")
] ??= new Map<string, Runner>()) as Map<string, Runner>

export const register = Effect.fn("ClaudeAISDK.register")(function* (ctx: Context, accounts: ClaudeAccounts.Interface) {
  const context = yield* Effect.context<never>()
  const run = Effect.runPromiseWith(context)
  const location = JSON.stringify([ctx.location.directory, ctx.location.workspaceID ?? null])
  const runner: Runner = (request, configDirs, signal) => run(accounts.run(request, configDirs), { signal })
  runners.set(location, runner)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (runners.get(location) === runner) runners.delete(location)
    }),
  )
  yield* ctx.aisdk.hook(
    "sdk",
    (evt) =>
      Effect.sync(() => {
        // opencode spreads the model's settings into options, next to the configured headers and body
        const connection = ClaudeQueryOptions.connectionEnv({
          settings: evt.options,
          headers: evt.options.headers,
          body: evt.options.body,
        })
        const fast = evt.options.fast === true
        const configDirs = ClaudeQueryOptions.configDirs(evt.options.configDir)
        const dependencies: ClaudeAgentLanguageModel.Dependencies = {
          run: (request, signal) => (runners.get(location) ?? runner)(request, configDirs, signal),
        }
        // Always replace: until the opencode fix ships, the npm fallback has already set the placeholder here
        evt.sdk = {
          languageModel: (modelID: string) =>
            new ClaudeAgentLanguageModel.Model(modelID, dependencies, connection, fast),
        }
      }),
    { providerID: ClaudeProvider.ID },
  )
})
