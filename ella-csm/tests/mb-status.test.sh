#!/bin/zsh
# zsh ~/.config/herdr-app/tests/mb-status.test.sh — uses a fake hogli, never the real login.
fails=0; T=$(mktemp -d)
ok(){ echo "  ok   $1"; }; bad(){ echo "  FAIL $1: got $2"; ((fails++)); }
fake(){ printf '#!/bin/zsh\nr=${@[-1]}\n%s\n' "$1" > $T/hogli; chmod +x $T/hogli; }
run(){ HOGLI=$T/hogli ~/.local/bin/mb-status; }

fake 'echo "  ID  NAME   ENGINE"; echo " 1 x postgres"'
out=$(run); [[ $out == '{"us": "ok", "eu": "ok"}' ]] && ok "both logged in" || bad "both logged in" "$out"

fake '[[ $r == eu ]] && { echo "Error: session expired, run metabase:login" >&2; exit 1; }; echo "ID NAME ENGINE"'
out=$(run); [[ $out == '{"us": "ok", "eu": "out"}' ]] && ok "eu expired" || bad "eu expired" "$out"

fake 'echo "something odd"; exit 0'
out=$(run); [[ $out == '{"us": "out", "eu": "out"}' ]] && ok "no database list counts as logged out" || bad "odd output" "$out"

fake 'echo "requests.exceptions.ConnectionError: Max retries exceeded" >&2; exit 1'
out=$(run); [[ $out == '{"us": "unknown", "eu": "unknown"}' ]] && ok "network error is unknown, not logged out" || bad "network error" "$out"

fake 'echo "401 Unauthorized" >&2; exit 1'
out=$(run); [[ $out == '{"us": "out", "eu": "out"}' ]] && ok "401 means logged out" || bad "401" "$out"

fake 'sleep 2; echo "ID NAME ENGINE"'
s=$(date +%s); run >/dev/null; (( $(date +%s)-s < 4 )) && ok "regions checked in parallel" || bad "parallel" "$(( $(date +%s)-s ))s"

out=$(HOGLI=$T/missing ~/.local/bin/mb-status); [[ $out == '{"us": "unknown", "eu": "unknown"}' ]] && ok "missing hogli is unknown" || bad "missing hogli" "$out"

rm -rf $T; (( fails )) && { echo "$fails failed"; exit 1; } || echo "all passed"
