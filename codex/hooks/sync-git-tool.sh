#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"
cwd="$(jq -r '.cwd // empty' <<<"$payload")"
[ -n "$cwd" ] || exit 0

root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$root" ] || exit 0

mode="$(git -C "$root" config --get agents.git-tool 2>/dev/null || true)"
case "$mode" in
	graphite)
		gt=true
		gs=false
		;;
	git-spice)
		gt=false
		gs=true
		;;
	*)
		gt=
		gs=
		;;
esac

start="# BEGIN agents.git-tool managed plugin selection"
end="# END agents.git-tool managed plugin selection"
config_dir="$root/.codex"
config="$config_dir/config.toml"

if [ -f "$config" ] && ! grep -Fq "$start" "$config"; then
	if grep -Eq '^\[plugins\."(gt|gs)@agents"\]$' "$config"; then
		jq -n --arg path "$config" '{systemMessage: ("Skipped stack-skill sync because " + $path + " has manually managed gt/gs plugin settings.")}'
		exit 0
	fi
fi

mkdir -p "$config_dir"
tmp="$config.tmp.$$"
trap 'rm -f "$tmp"' EXIT

inside=false
replaced=false
if [ -f "$config" ]; then
	while IFS= read -r line || [ -n "$line" ]; do
		if [ "$line" = "$start" ]; then
			inside=true
			replaced=true
			if [ -n "$gt" ]; then
				printf '%s\n[plugins."gt@agents"]\nenabled = %s\n\n[plugins."gs@agents"]\nenabled = %s\n%s\n' "$start" "$gt" "$gs" "$end" >>"$tmp"
			fi
			continue
		fi
		if [ "$inside" = true ]; then
			[ "$line" = "$end" ] && inside=false
			continue
		fi
		printf '%s\n' "$line" >>"$tmp"
	done <"$config"
fi

if [ "$replaced" = false ] && [ -n "$gt" ]; then
	[ ! -s "$tmp" ] || printf '\n' >>"$tmp"
	printf '%s\n[plugins."gt@agents"]\nenabled = %s\n\n[plugins."gs@agents"]\nenabled = %s\n%s\n' "$start" "$gt" "$gs" "$end" >>"$tmp"
fi

if [ ! -s "$tmp" ]; then
	rm -f "$config"
	rmdir "$config_dir" 2>/dev/null || true
	exit 0
fi

if [ -f "$config" ] && cmp -s "$tmp" "$config"; then
	exit 0
fi

mv "$tmp" "$config"
exclude="$(git -C "$root" rev-parse --path-format=absolute --git-path info/exclude)"
mkdir -p "$(dirname "$exclude")"
touch "$exclude"
grep -Fxq '/.codex/config.toml' "$exclude" || printf '/.codex/config.toml\n' >>"$exclude"

jq -n --arg mode "${mode:-main}" '{systemMessage: ("Updated Codex stack skills for agents.git-tool=" + $mode + "; the selection applies to the next thread.")}'
