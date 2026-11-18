This item came from an alert posted in Slack: SLACK_LINK
Read that post first (and its thread, if it has replies): it's the source, and the to-do line is only a summary of it.

The very first thing to do once you've read it: save the post (and any thread replies) word for word, with the channel name and date, to POST_FILE. A separate Codex check starts from that file and investigates on its own, so don't add your own reading of it there.

Ella wants to come back to a verdict, not raw findings. So investigate before drafting anything:
- Is it real? Check the numbers at the source (the account's PostHog data, billing, the ticket), not only what the alert says. Alerts can be wrong (a project move, a by-design change, a one-off).
- Is it still happening, and how does it compare with the account's normal pattern? Always compare with the same weekday over the previous three or four weeks, and any cycle you know of (sale dates, month end, releases). Give those numbers in the handover, e.g. "Sunday 16 Nov: 41k; the three Sundays before: 39k, 43k, 40k".
- What's the most likely cause, and what's the evidence for it? Use the recipes in her memory (spike, usage-drop, flag-request, billing) where they fit.
- Does it need her to act, and how urgent is it?

Start your handover with one line: "Action needed: …" or "No action: …" (with the reason). Then the evidence, briefly. Draft a message only if action is needed. Say plainly what you couldn't verify. If you're not sure, say "Action needed: worth a look because …" rather than "No action".

After writing the handover, check it: run the verify-output skill on the handover (not on this prompt). If it corrects anything, fix the handover file. Then write the result as JSON to VERIFY_FILE, e.g. {"claims": 9, "corrected": 0, "unverified": 1, "notes": "period start not confirmed"}. Count honestly: an item auto-closes only when nothing was corrected and nothing is left unverified, so a claim you couldn't check counts as unverified. Write VERIFY_FILE last, and don't start a Codex check yourself (one is already running).

Afterwards you may get one more message asking for a short CA note, if everything agreed there's nothing to do. Do only what it asks.
