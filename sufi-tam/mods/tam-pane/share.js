// What the Share button asks the chat for. Edit the wording here.
// The chat writes the piece from its own conversation, then sends it where chosen.

export const FORMATS = [
  { key: "bullets", label: "Bullet summary", hint: "Up to 5 one-line points, internal",
    text: "a summary of at most 5 bullet points, one line each, for sharing internally" },
  { key: "slack-team", label: "Slack message · team", hint: "Short, internal",
    text: "a short Slack message for my team at PostHog (internal), a few sentences at most" },
  { key: "slack-customer", label: "Slack message · customer", hint: "Short, customer-safe",
    text: "a short Slack message to the customer, in my voice. Leave out anything internal: our own numbers and targets, pricing or deal talk, opinions about the customer, and internal tools or names they wouldn't know" },
  { key: "medium", label: "Medium summary", hint: "A few short paragraphs",
    text: "a medium-length summary: a few short paragraphs, or a short list per topic" },
  { key: "full", label: "Full write-up", hint: "Detailed, with headings",
    text: "a full, detailed write-up with headings: context, what we found (with the numbers and where they came from), open questions, and next steps" },
];

export const DESTINATIONS = [
  { key: "chat", label: "Here in the chat",
    text: "Just put it here in the chat." },
  { key: "gdoc", label: "Google Doc",
    text: "Create a Google Doc with it in my Drive (the Google Drive connector), titled \"<account> · <topic> · <today's date>\", and give me the link. Don't share it with anyone." },
  { key: "ca", label: "Customer Analytics note",
    text: "Add it as a note on the account in Customer Analytics, using the PostHog MCP's account notebook tools. If it isn't clear which account it's for, ask me first. Give me the note's link." },
  { key: "slack", label: "Slack draft",
    text: "Save it as a Slack draft (slack_send_message_draft) in the right channel or DM. Ask me where if it isn't clear. Never send it. If you can't make a draft, put it here in the chat instead." },
];

export function sharePrompt(format, dest) {
  return [
    `Write ${format.text}, based on this chat.`,
    "Keep it plain and specific, in my voice (no AI tells), and only state what we actually found here.",
    dest.text,
    "Clicking Share is my go-ahead for this one export; don't write anywhere else.",
  ].join(" ");
}
