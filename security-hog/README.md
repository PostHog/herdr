# SecurityHog

Your team's open SecurityHog findings in Herdr's sidebar.
Read a finding in a pane, fix it in its own worktree with an agent, assign it to yourself, or ask for a new triage.
[`RECIPE.md`](RECIPE.md) has how it behaves and what it's built from.

## Set up

Connect Tailscale first: SecurityHog's MCP server is only on PostHog's tailnet.

From the repo root:

```sh
./install.sh enable security-hog
mkdir -p ~/.config/security-hog
cp security-hog/config.example.json ~/.config/security-hog/config.json
$EDITOR ~/.config/security-hog/config.json   # the MCP address, your team and checkouts
herdr-app do layout.switch '{"name":"security"}'
```

Then click **Sign in to SecurityHog** in the sidebar, sign in with Google, and select **Allow**.
A sign-in lasts 8 hours. Or from a shell:

```sh
python3 ~/.config/herdr-app/mods/security-hog/shmcp.py login
```

`config.json` has:

- `url` (required): SecurityHog's MCP address. This repo is public, so it isn't here: copy it from the "use SecurityHog from Claude Code" section of SecurityHog's README.
- `team`: the team whose findings to list, such as `team-devex`. Without it the list shows the findings assigned to you.
- `repos`: GitHub `owner/name` to its local checkout, for **Fix locally**. A repository missing here is asked for once with a folder picker.
- `agent`: a key from Herdr's program table, such as `claude`.
- `email`: your SecurityHog email, for **Assign to me**. Defaults to `git config --global user.email`.

It needs `python3`, `git`, and the [GitHub CLI](https://cli.github.com) for fix pull requests.

## In another layout

To keep another layout's sidebar and add only a Security bar (count, critical and high, refresh, and a button that opens the list as a dialog), give it a block like the inbox's compact one:

```json
{ "id": "security", "type": "block", "content": { "mod": "security-hog", "props": { "compact": true } }, "size": { "px": 32 } }
```

The bar is 31 px, centered in its block. Stacked under the inbox's compact bar, give both blocks 32 px, or the rows end up far apart.

Or the whole list:

```json
{ "id": "security", "type": "block", "size": { "weight": 2 }, "min": 120, "content": { "mod": "security-hog" } }
```

`security-hog.refresh` reloads the list; bind it in `~/.config/herdr-app/keys.json` if you like.
