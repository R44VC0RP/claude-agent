# Claude Agent plugin

Experimental opencode plugin that runs a user's own Claude subscription inside opencode through Claude Code, using only documented features of the Claude Agent SDK.

This is a fork of [Tarquinen/opencode-claude-agent](https://github.com/Tarquinen/opencode-claude-agent) with fast mode, account rotation, and a limit cooldown: an account that hits a usage limit is skipped until it resets, and requests fail at once instead of retrying when every account is at its limit.

Not intended for release. See [PLAN.md](./PLAN.md) for the research, design and order of work, [TESTING.md](./TESTING.md) for how it is tested.

## Install

Requires OpenCode 2.2.3 or newer.

1. Install Claude Code and sign in with `claude auth login` on the machine running OpenCode. An existing login is reused.
2. Install the plugin:

   ```sh
   opencode plugin add github:R44VC0RP/claude-agent
   ```


3. To disable the bundled Claude Agent provider, add `"-opencode.provider.claude-agent"` to `plugins` in `opencode.json`. Keep `"github:R44VC0RP/claude-agent"` and your other plugin entries.
4. In OpenCode, use `/connect` → **Claude Agent**, then `/models` to choose a model and effort level.

To update, run `opencode plugin update github:R44VC0RP/claude-agent`. To uninstall, run `opencode plugin remove github:R44VC0RP/claude-agent`.

### Example setup

Plugin entries plus two rotating accounts, in the global `opencode.json`:

```json
{
  "plugins": ["-opencode.provider.claude-agent", "github:R44VC0RP/claude-agent"],
  "providers": {
    "claude-agent": {
      "settings": { "configDir": ["~/.claude", "~/.claude-2"] }
    }
  }
}
```

## Use a second Claude account

1. Sign in to the second account in a separate folder. Your usual login stays unchanged.

   ```sh
   CLAUDE_CONFIG_DIR="$HOME/.claude-2" claude auth login
   ```

2. Add Sonnet and Opus for the second account to your `opencode.json`:

   ```json
   {
     "providers": {
       "claude-agent": {
         "models": {
           "sonnet-2": {
             "modelID": "sonnet",
             "name": "Sonnet (Claude 2)",
             "settings": { "configDir": "~/.claude-2" }
           },
           "opus-2": {
             "modelID": "opus",
             "name": "Opus (Claude 2)",
             "settings": { "configDir": "~/.claude-2" }
           }
         }
       }
     }
   }
   ```

3. In `/models`, choose **Sonnet (Claude 2)** or **Opus (Claude 2)** for the second account. The original entries still use your usual login.

To use one account for every model in a project, such as a work account, set `configDir` for the provider in that project's `opencode.json` instead:

```json
{ "providers": { "claude-agent": { "settings": { "configDir": "~/.claude-work" } } } }
```

## Rotate between accounts

If you have several interchangeable accounts, OpenCode can move chats between them as they hit usage limits.

1. Sign in to each account in its own folder:

   ```sh
   CLAUDE_CONFIG_DIR="$HOME/.claude-1" claude auth login
   CLAUDE_CONFIG_DIR="$HOME/.claude-2" claude auth login
   ```

2. List the folders as `configDir` in your `opencode.json`:

   ```json
   {
     "providers": {
       "claude-agent": {
         "settings": { "configDir": ["~/.claude-1", "~/.claude-2"] }
       }
     }
   }
   ```

An account that hits a limit is skipped until the limit resets, so new chats and subagents don't start Claude on it again. A weekly Opus or Sonnet limit only skips that account for that model family. When every account is at its limit, requests fail at once with the earliest reset time instead of retrying.

## Use fast mode

The Agent SDK keeps fast mode off unless it is opted in. Add an Opus entry with `fast` to your `opencode.json`:

```json
{
  "providers": {
    "claude-agent": {
      "models": {
        "opus-fast": {
          "modelID": "opus",
          "name": "Opus (fast)",
          "settings": { "fast": true }
        }
      }
    }
  }
}
```

Fast mode only works on Opus models and bills as extra usage on a subscription. Combine it with `configDir` to use it on a second account.
