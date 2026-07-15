#!/bin/bash
# @file post-edit-update.sh
# @description PostToolUse hook — bump @lastUpdated / last_updated header, then stage the file
# @version 1.1.0
# @created 2026-04-26T15:14:56Z
# @lastUpdated 2026-04-26T16:15:14Z

input=$(cat)

# Extract file_path from hook JSON (try jq, fall back to python3, then node, then grep)
if command -v jq >/dev/null 2>&1; then
  file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
elif command -v python3 >/dev/null 2>&1; then
  file_path=$(echo "$input" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''),end='')" \
    2>/dev/null)
elif command -v node >/dev/null 2>&1; then
  file_path=$(echo "$input" | node -e \
    "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ try{const o=JSON.parse(d); process.stdout.write((o.tool_input&&o.tool_input.file_path)||'')}catch(e){} })" \
    2>/dev/null)
else
  file_path=$(echo "$input" | grep -o '"file_path":"[^"]*"' | head -1 | cut -d'"' -f4)
fi

[ -z "$file_path" ] && exit 0
[ ! -f "$file_path" ] && exit 0

# ---------------------------------------------------------------------------
# Determine whether the file has a real content change compared to HEAD.
# Strategy: strip the timestamp line(s) from both the working copy and the
# HEAD version, then compare.  If only the timestamp differs, skip the bump.
# ---------------------------------------------------------------------------

# Get the repo-relative path so we can call `git show HEAD:<path>`.
# git ls-files --error-unmatch returns the relative path when tracked,
# or exits non-zero for new/untracked files.
git_rel_path=$(git ls-files --error-unmatch "$file_path" 2>/dev/null)
is_new_file=$?   # 0 = tracked, non-zero = new/untracked

if [ "$is_new_file" -ne 0 ]; then
  # New untracked file — always bump (if marker present) and stage.
  real_change=1
else
  # Strip the timestamp marker line from both HEAD and working copy, then compare.
  # Covers:  " * @lastUpdated ..."  (.ts/.js/.cjs)
  #          "# @lastUpdated ..."   (.sh)
  #          "last_updated: ..."    (.md front matter)
  head_stripped=$(git show HEAD:"$git_rel_path" 2>/dev/null | grep -v '@lastUpdated\|^last_updated:')
  work_stripped=$(grep -v '@lastUpdated\|^last_updated:' "$file_path")

  if [ "$head_stripped" = "$work_stripped" ]; then
    # Only the timestamp changed (or nothing changed at all) — nothing to do.
    exit 0
  fi
  real_change=1
fi

# There is a real content change — bump the timestamp and stage.
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

case "$file_path" in
  *.ts|*.js|*.cjs|*.sh)
    if grep -q '@lastUpdated' "$file_path" 2>/dev/null; then
      sed -i "s|^ \* @lastUpdated .*| \* @lastUpdated ${now}|" "$file_path"
      # .sh files use "# @lastUpdated" (no leading " * ")
      sed -i "s|^# @lastUpdated .*|# @lastUpdated ${now}|" "$file_path"
    fi
    ;;
  *.md)
    # Replace last_updated only in the first 20 lines (YAML front matter always lives there)
    if grep -q '^last_updated:' "$file_path" 2>/dev/null; then
      sed -i "1,20s|^last_updated: .*|last_updated: ${now}|" "$file_path"
    fi
    ;;
esac

# Stage the file (includes the timestamp bump)
git add "$file_path" 2>/dev/null || true

exit 0
