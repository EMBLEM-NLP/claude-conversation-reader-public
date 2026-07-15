#!/bin/bash
# @file stop-git-check.sh
# @description Claude Code Stop hook — ensures changes are committed/pushed
# @version 1.1.0
# @created 2026-04-15T17:15:45Z
# @lastUpdated 2026-04-15T17:15:45Z

# Read the JSON input from stdin
input=$(cat)

# Check if stop hook is already active (recursion prevention)
# Use grep instead of jq for portability (jq may not be installed)
if echo "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

# Check if we're in a git repository - bail if not
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

no_pr_reminder="Do not create a pull request unless the user has explicitly asked for one."

# Check for uncommitted changes (both staged and unstaged)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "There are uncommitted changes in the repository. Please commit and push these changes to the remote branch. $no_pr_reminder" >&2
  exit 2
fi

# Check for untracked files that might be important
untracked_files=$(git ls-files --others --exclude-standard)
if [[ -n "$untracked_files" ]]; then
  echo "There are untracked files in the repository. Please commit and push these changes to the remote branch. $no_pr_reminder" >&2
  exit 2
fi

current_branch=$(git branch --show-current)
if [[ -n "$current_branch" ]]; then
  if git rev-parse "origin/$current_branch" >/dev/null 2>&1; then
    unpushed=$(git rev-list "origin/$current_branch..HEAD" --count 2>/dev/null) || unpushed=0
    if [[ "$unpushed" -gt 0 ]]; then
      echo "There are $unpushed unpushed commit(s) on branch '$current_branch'. Please push these changes to the remote repository. $no_pr_reminder" >&2
      exit 2
    fi
  else
    unpushed=$(git rev-list "origin/HEAD..HEAD" --count 2>/dev/null) || unpushed=0
    if [[ "$unpushed" -gt 0 ]]; then
      echo "Branch '$current_branch' has $unpushed unpushed commit(s) and no remote branch. Please push these changes to the remote repository. $no_pr_reminder" >&2
      exit 2
    fi
  fi
fi

exit 0
