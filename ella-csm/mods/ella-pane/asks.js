// What the Claude-pane buttons type into the session. Edit the wording here.
// `tint` is a theme slot (ansi palette), so the colour follows light/dark.
export const ASKS = [
  {
    key: "verify",
    label: "verify",
    tint: "ansi4",
    text: "Check your last substantive answer (the one before this message) two ways at once. First, write that answer word for word to a file in your scratchpad and start a Codex check of it in the background (Bash run_in_background, 600000 ms timeout): `codex-pane \"<this folder>\" \"Fact-check the answer in <file>. It was written for a PostHog CSM. Where you can, check claims against the sources (PostHog's internal CS project and the customer's project via the PostHog MCP, Slack, Granola, the code) rather than from memory. List claims that are wrong, unsupported or overstated, most serious first, each with the quote and why. Be brief.\"`. Then run the verify-output skill on the same answer while Codex works. When both are back, treat Codex's points as leads, not verdicts: check each one and say in a sentence why you accept or reject it. Fold everything in the way my CLAUDE.md says: correct anything refuted, say plainly what's unverified and what would settle it, and end with the one-line 'Independently checked' summary, adding what Codex flagged and how many of its points held up. If Codex fails or is still running after the skill finishes, say so in one line rather than inventing its review.",
  },
  {
    key: "ca",
    label: "log to CA",
    tint: "ansi2",
    text: "Log the work from this session to the right account's Customer Analytics note, following my memory notes on CA notes and CA note tags (tag ca:<type> + ca-source:<src>, never invent tags). Keep it lean and in my voice. If it's not clear which account, ask me first. Then record the same work in HogPilot for that account with `hp memory add` (durable facts only, --source session, --source-ref ca-note-<short_id>; check `hp context <account>` first and use --supersedes for any fact this makes stale). Give me the note link when it's done.",
  },
  {
    key: "draft",
    label: "draft reply",
    tint: "ansi5",
    text: "Turn what we've just worked out into a reply to the customer, in my voice. Read my customer reply style note and the 'how we talk' style note in full first, and verify any technical claims before drafting. If the recipient is in a customer Slack channel, make a Slack draft; otherwise a Superhuman draft, opened in the desktop app. Never send it.",
  },
  {
    key: "devbox",
    label: "→ devbox",
    tint: "ansi3",
    text: "Hand what we're working on over to Claude on my devbox, so it keeps going while my laptop is shut. Write a self-contained handover: the goal, what we've found so far (paste the actual findings, numbers and links, not pointers to them), what's left to do, what I want back, and anything it must not do (it must never message customers or post as me). The devbox has none of my connectors (no Slack, PostHog, Granola, Gmail) and none of this Mac's files, so include everything it needs; if the remaining work can't be done without those, tell me that instead of sending. Leave out tokens and passwords. Then send it by running `away` with the handover as its one argument (write it to a temp file and run `away \"$(cat <file>)\"` so the quoting survives), and tell me the space name it printed. I'll check in from the Claude app.",
  },
  // A thank-you: sent as is, without the space name.
  { key: "thanks", label: "💖", tint: "ansi1", text: "nice tysm", plain: true },
];

// The space's name tells Claude which account, in account spaces (acme, dunder-mifflin).
export function withContext(text, spaceName, plain = false) {
  if (plain) return text;
  const generic = !spaceName || spaceName === "~" || spaceName === "claude" || spaceName.startsWith("morning");
  return generic ? text : `${text} (We're in the Herdr space "${spaceName}".)`;
}
