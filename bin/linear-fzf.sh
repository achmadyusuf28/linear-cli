#!/usr/bin/env bash
set -euo pipefail

ROOT="${HOME}/linear-issues"

if ! command -v fzf >/dev/null 2>&1; then
  echo "fzf is required (install and ensure it's on PATH)." >&2
  exit 1
fi

mapfile -t dirs < <(find "$ROOT" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sort)
if [ "${#dirs[@]}" -eq 0 ]; then
  echo "No local issues found under $ROOT."
  exit 1
fi

choices=()
for d in "${dirs[@]}"; do
  day=$(basename "$(dirname "$d")")
  code=$(basename "$d")
  title=""
  meta="$d/metadata.json"
  if [ -f "$meta" ]; then
    # naive JSON parse for title; avoids jq dependency
    title=$(sed -n 's/.*"title"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' "$meta" | head -n1)
  fi
  choices+=("${day}/${code} — ${title}	${d}")
done

selected=$(printf '%s\n' "${choices[@]}" | fzf --with-nth=1 --delimiter=$'\t' || true)
[ -z "$selected" ] && exit 0

path=$(awk -F'\t' '{print $2}' <<< "$selected")
cd "$path" || { echo "Failed to cd to $path" >&2; exit 1; }

# Start an interactive shell in the issue directory
exec "${SHELL:-bash}" -i
