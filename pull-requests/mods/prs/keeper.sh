set -u
dir="$1"; repo="$2"; number="$3"; checkout="$4"; start_sha="$5"; model="$6"; context="$7"; prompt="$8"
mkdir -p "$dir"
echo running > "$dir/status"
date -u +%FT%TZ > "$dir/started"
printf '%s\n' "$context" > "$dir/context.json"
tree=""
head_ref="refs/herdr-prs/keep-$(basename "$dir")"

finish() {
  echo "$2" > "$dir/summary"
  echo "$1" > "$dir/status"
  date -u +%FT%TZ > "$dir/finished"
  exit 0
}

discard() {
  [ -n "$tree" ] && git -C "$checkout" worktree remove --force "$tree" >/dev/null 2>&1
  git -C "$checkout" update-ref -d "$head_ref" >/dev/null 2>&1
  tree=""
}

[ -e "$checkout/.git" ] || gh repo clone "$repo" "$checkout" -- --filter=blob:none >"$dir/clone.log" 2>&1 || finish failed "Couldn't clone $repo."
git -C "$checkout" fetch -q origin "+pull/$number/head:$head_ref" >"$dir/fetch.log" 2>&1 || finish failed "Couldn't fetch the PR head."
fetched=$(git -C "$checkout" rev-parse "$head_ref")
if [ "$fetched" != "$start_sha" ]; then
  discard
  finish superseded "The PR head moved to ${fetched:0:7} before the run started."
fi
tree="$HOME/.herdr/worktrees/prs/keep-${repo//\//-}-$number-$(basename "$dir")"
git -C "$checkout" worktree add -q --detach "$tree" "$head_ref" >>"$dir/fetch.log" 2>&1 || { tree=""; finish failed "Couldn't create the keeper worktree."; }
printf '%s\n' "$tree" > "$dir/tree"
cd "$tree"

GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.pushurl GIT_CONFIG_VALUE_0=/dev/null/the-keeper-pushes-for-you \
claude -p "$prompt" --model "$model" --output-format text \
  --strict-mcp-config --permission-mode dontAsk \
  --allowedTools "Bash" "Read" "Edit" "Write" "Grep" "Glob" \
  --disallowedTools "Bash(git push:*)" "Bash(git rebase:*)" "Bash(git reset --hard:*)" "Bash(gh pr merge:*)" "Bash(gh pr close:*)" "Bash(gh pr review:*)" "Bash(trunk:*)" "WebFetch" "WebSearch" \
  > "$dir/agent.txt" 2> "$dir/agent.err"
agent_exit=$?

result=$(grep -E '^KEEPER_RESULT ' "$dir/agent.txt" | tail -n 1 | sed 's/^KEEPER_RESULT //')
[ -n "$result" ] || result='{"outcome":"unknown","reason":"The agent ended without a KEEPER_RESULT line."}'
printf '%s\n' "$result" > "$dir/result.json"
git rev-parse HEAD > "$dir/head"
git rev-list --count "$start_sha..HEAD" > "$dir/commits"
git status --porcelain > "$dir/dirty"

if [ "$agent_exit" -ne 0 ]; then
  discard
  finish failed "Claude exited with $agent_exit; see agent.err in $dir."
fi
commits=$(cat "$dir/commits")
if [ "$commits" = "0" ]; then
  discard
  finish done "No commits."
fi
finish done "$commits commit(s) ready to push."
