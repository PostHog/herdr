set -u
dir="$1"; repo="$2"; number="$3"; checkout="$4"; model="$5"; judge_model="$6"; shift 6
mkdir -p "$dir"
echo running > "$dir/status"
date -u +%FT%TZ > "$dir/started"
tree=""
head_ref="refs/herdr-prs/$(basename "$dir")"

finish() {
  echo "$2" > "$dir/summary"
  echo "$1" > "$dir/status"
  date -u +%FT%TZ > "$dir/finished"
  [ -n "$tree" ] && git -C "$checkout" worktree remove --force "$tree" >/dev/null 2>&1
  git -C "$checkout" update-ref -d "$head_ref" >/dev/null 2>&1
  exit 0
}

read_only_claude() {
  claude -p "$1" --model "$2" --output-format text \
    --setting-sources "" --strict-mcp-config --permission-mode dontAsk \
    --allowedTools "Read(/$tree/**)" "Read(/$dir/**)" \
    --disallowedTools "Bash" "Edit" "Write" "NotebookEdit" "WebFetch" "WebSearch"
}

[ -e "$checkout/.git" ] || gh repo clone "$repo" "$checkout" -- --filter=blob:none >"$dir/clone.log" 2>&1 || finish failed "Couldn't clone $repo on the devbox."
tree="$HOME/.herdr/worktrees/prs/review-${repo//\//-}-$number-$(basename "$dir")"
git -C "$checkout" fetch -q origin "+pull/$number/head:$head_ref" >"$dir/fetch.log" 2>&1 || { tree=""; finish failed "Couldn't fetch the PR head."; }
git -C "$checkout" worktree add -q --detach "$tree" "$head_ref" >>"$dir/fetch.log" 2>&1 || { tree=""; finish failed "Couldn't create the review worktree."; }
cd "$tree"
gh pr diff "$number" -R "$repo" > "$dir/diff.patch" 2>>"$dir/fetch.log" || finish failed "Couldn't read the PR diff."
gh pr view "$number" -R "$repo" --json title,body,baseRefName,headRefName,author > "$dir/pr.json" 2>>"$dir/fetch.log"

lens_count=$(($# - 1))
index=0
pids=()
for prompt in "$@"; do
  index=$((index + 1))
  [ "$index" -gt "$lens_count" ] && break
  read_only_claude "$prompt" "$model" > "$dir/lens$index.txt" 2> "$dir/lens$index.err" &
  pids+=("$!")
done
failed_lenses=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed_lenses=$((failed_lenses + 1))
done
[ "$failed_lenses" -eq 0 ] || finish failed "$failed_lenses of $lens_count reviewers failed; see lens*.err in $dir."

grep -h '^{' "$dir"/lens*.txt > "$dir/lens_findings.jsonl" 2>/dev/null
if [ ! -s "$dir/lens_findings.jsonl" ]; then
  : > "$dir/findings.jsonl"
  finish done "No findings."
fi
read_only_claude "${!#}" "$judge_model" > "$dir/judge.txt" 2> "$dir/judge.err" || finish failed "The judge failed; see judge.err in $dir."
grep -h '^{' "$dir/judge.txt" > "$dir/findings.jsonl"
count=$(wc -l < "$dir/findings.jsonl" | tr -d ' ')
finish done "$count finding(s) after the judge."
