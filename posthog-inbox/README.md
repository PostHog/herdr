# PostHog inbox

The PostHog self-driving inbox inside Herdr, with Conductor-style tasks:
pick a report up into its own git worktree and agent, hand it to a PostHog cloud task, or both,
and track those beside tasks you start from scratch.
[`RECIPE.md`](RECIPE.md) has how it behaves and what it's built from.

## Set up

From the repo root:

```sh
./install.sh enable posthog-inbox
mkdir -p ~/.config/posthog-inbox
cp posthog-inbox/config.example.json ~/.config/posthog-inbox/config.json
chmod 600 ~/.config/posthog-inbox/config.json
$EDITOR ~/.config/posthog-inbox/config.json   # add a PostHog personal API key
herdr-app do layout.switch '{"name":"inbox"}'
```

`config.json` has:

- `api_key`: a PostHog personal API key. `POSTHOG_PERSONAL_API_KEY` in Herdr's environment works too.
- `default_repo`: the GitHub `owner/name` a report with no repository of its own starts in.
- `repos`: GitHub `owner/name` to its local checkout.
- `agent`: a key from Herdr's program table, such as `claude`.

Check the key from a shell:

```sh
python3 ~/.config/herdr-app/mods/ph-inbox/phmcp.py check
```

It needs `python3`, `git`, and the [GitHub CLI](https://cli.github.com) logged in (`gh auth login`) for pull requests.

## Just the triage bar

To keep another layout's sidebar and add only the Inbox header (count, triage and refresh), give that layout a block like:

```json
{ "id": "inbox", "type": "block", "content": { "mod": "ph-inbox", "props": { "compact": true } }, "size": { "px": 40 } }
```

## Keys

The mod binds no keys itself. These commands can be bound in `~/.config/herdr-app/keys.json`:

- `ph-inbox.new`: the New task dialog.
- `ph-inbox.triage`: the triage round.
- `ph-inbox.refresh`: reload the inbox.

## Working on it

- Any view can be shown as a tab to look at it: `herdr-app do tab.new --mod ph-inbox --props '{"view":"new"}'`.
  `herdr-app check ~/.config/herdr-app/mods/ph-inbox` only renders the sidebar.
- A mod reads its layout or overlay props with `props()` from `herdr`. `init`'s first argument is not them.
- A loop on `nextCommand()` must touch `cx` before acting, or loops from older builds act too.
