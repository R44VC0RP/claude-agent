export * as ClaudeAgentError from "./claude-agent-error.js"

import { APICallError } from "@ai-sdk/provider"
import type { SDKAssistantMessageError, SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"

export class Failure extends Error {
  constructor(
    message: string,
    // A subscription limit refused the request, rather than an API error that Claude Code already retried.
    readonly limited: boolean,
    // When the limit lifts, in epoch milliseconds, and which limit it was.
    readonly resetsAt?: number,
    readonly limitType?: SDKRateLimitInfo["rateLimitType"],
  ) {
    super(message)
  }
}

// OpenCode retries plain errors for about a minute and a half. A subscription limit lasts hours, so report it
// as a 429 that says "usage limit", which OpenCode classifies as an exhausted quota and does not retry.
export function quota(message: string) {
  return new APICallError({
    message: /usage limit/i.test(message) ? message : `Claude Code usage limit reached: ${message}`,
    url: "claude-agent://limit",
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: false,
  })
}

// Keep request-local diagnostics until the terminal result. A usage warning alone
// is not a failed request, and Claude Code owns any retries before this result.
export function make() {
  let code: SDKAssistantMessageError | undefined
  let rejected: SDKRateLimitInfo | undefined
  return (message: SDKMessage): Failure | undefined => {
    if (message.type === "rate_limit_event") {
      rejected = message.rate_limit_info.status === "rejected" ? message.rate_limit_info : undefined
    }
    if (message.type === "assistant" && message.parent_tool_use_id === null && message.error) code = message.error
    if (message.type !== "result") return

    const status = message.subtype === "success" ? (message.api_error_status ?? undefined) : undefined
    const httpError = status !== undefined && status >= 400
    if (message.subtype === "success" && !message.is_error && !httpError) return
    const result = (message.subtype === "success" ? message.result : message.errors.join("\n")).replaceAll(
      "Please run /login",
      "Run `claude auth login` in a terminal",
    )
    const failure =
      status !== undefined && status >= 500
        ? (status === 529 ? "Anthropic is overloaded (529)." : `Anthropic returned HTTP ${status}.`) +
          " Claude Code exhausted its retries. Try again shortly."
        : result
    const limited = code === "rate_limit" || (rejected !== undefined && status === 429)
    const window = rejected?.rateLimitType?.replaceAll("_", " ")
    const limit = limited && !failure ? `Claude Code usage limit reached${window ? ` (${window})` : ""}.` : failure
    const resetsAt = limited && rejected?.resetsAt ? rejected.resetsAt * 1000 : undefined
    const reset = resetsAt ? ` Resets at ${new Date(resetsAt).toISOString()}.` : ""
    const text = limit + reset
    const limitType = limited ? rejected?.rateLimitType : undefined
    if (text) return new Failure(text, limited, resetsAt, limitType)
    if (status)
      return new Failure(`Claude Code could not finish its reply (HTTP ${status})`, limited, resetsAt, limitType)
    return new Failure("Claude Code could not finish its reply", limited, resetsAt, limitType)
  }
}
