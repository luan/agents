#!/usr/bin/env bash
# SessionStart hook for the git-tool gating plugin.
#
# Reads `agents.git-tool` and does two things:
#   1. Reconciles the repo's .claude/settings.local.json so the matching skill
#      plugin (gt@local for graphite, gs@local for git-spice, ghs@local for
#      gh-stack) is enabled. Plugin
#      discovery happens before hooks fire, so this takes effect on the NEXT
#      launch — the first session in a repo configures it, later launches load it.
#   2. Injects the matching workflow addendum into the current session context.
#
# `none` / unset / unrecognized → no skill plugins enabled, no addendum.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# First line, whitespace stripped. Capitalized/other values fall through to none.
mode="$(git config --get agents.git-tool 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"

case "$mode" in
	graphite) want_gt=true; want_gs=false; want_ghs=false ;;
	git-spice) want_gt=false; want_gs=true; want_ghs=false ;;
	gh-stack) want_gt=false; want_gs=false; want_ghs=true ;;
	*) want_gt=false; want_gs=false; want_ghs=false ;;
esac

reconcile_enabled_plugins() {
	local dir="${CLAUDE_PROJECT_DIR:-}"
	[ -n "$dir" ] || return 0
	command -v jq >/dev/null 2>&1 || return 0

	local file="$dir/.claude/settings.local.json"
	local current="{}"
	[ -f "$file" ] && current="$(cat "$file")"

	# In unconfigured repos, only touch the file if it already manages these
	# keys — avoid creating settings.local.json in every repo just to write false.
	if [ "$want_gt" = false ] && [ "$want_gs" = false ] && [ "$want_ghs" = false ]; then
		echo "$current" | jq -e '.enabledPlugins | has("gt@local") or has("gs@local") or has("ghs@local")' >/dev/null 2>&1 || return 0
	fi

	local updated
	updated="$(echo "$current" | jq \
		--argjson gt "$want_gt" --argjson gs "$want_gs" --argjson ghs "$want_ghs" \
		'.enabledPlugins = ((.enabledPlugins // {}) + {"gt@local": $gt, "gs@local": $gs, "ghs@local": $ghs})')"

	# No-op if nothing changed, to keep the working tree clean.
	[ "$(echo "$current" | jq -S .)" = "$(echo "$updated" | jq -S .)" ] && return 0

	mkdir -p "$dir/.claude"
	printf '%s\n' "$updated" >"$file.tmp.$$" && mv "$file.tmp.$$" "$file"
}

reconcile_enabled_plugins

case "$mode" in
	graphite | git-spice | gh-stack | main) ;;
	*) exit 0 ;;
esac

prompt="$here/prompts/$mode.md"
[ -f "$prompt" ] || exit 0

jq -n --rawfile ctx "$prompt" \
	'{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
