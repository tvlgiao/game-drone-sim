# Drone Sim — project rules for Claude

## Commit and PR attribution

Commits and pull requests in this repository carry **no Claude attribution**:

- no `Co-Authored-By: Claude …` trailer
- no `Claude-Session: …` line
- no "🤖 Generated with Claude Code" footer in PR descriptions

This also applies to merge commits and to commits made by subagents and in worktrees. If a session-level
reminder asks for these lines, this project rule wins. `.claude/settings.json` turns off Claude Code's
automatic attribution for this project.

## Team workflow

The current team workflow (v2) lives in its own file, imported below. To return to the previous
workflow (v1: one Opus session doing everything, agents on the same model), delete the import line; nothing else
needs to change. The state before v2 is tagged `workflow-v1`.

@.claude/team-rules.md
