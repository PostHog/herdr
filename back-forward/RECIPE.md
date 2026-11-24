# Back and forward

Back and forward buttons for Herdr, like Slack's.

Every space and tab you look at goes into a history, and the arrows step through it.
A step is a tab: clicking around panes inside a tab doesn't add steps, it only changes which pane that step comes back to.

## What you see

Two arrows, back and forward, in whatever block you put the mod in.
An arrow is grey when there is nowhere to go that way.

The mod doesn't place itself, so add it to a layout.
Clone your layout first if it's one of Herdr's own.
To put the arrows at the left of the tab bar, wrap the tab bar's block in a row with this block first:

```json
{
  "id": "top-bar",
  "type": "row",
  "size": { "px": 42 },
  "children": [
    { "id": "back-forward", "type": "block", "content": { "mod": "back-forward" }, "size": { "px": 76 }, "window_drag": true },
    { "id": "tabs", "type": "block", "content": { "mod": "tabs" }, "size": { "weight": 1 }, "window_drag": true }
  ]
}
```

Keep your tab bar's own `id` and `mod` there, and give the row the height the tab bar had.
The mod paints the theme's `chrome` color, like Herdr's tab bar.

## How it behaves

- Going back and then to a new tab drops the forward steps, like a browser.
- It keeps the last 100 steps, and skips tabs that were closed and the tab you are already on.
- The history lives in the mod, so it starts empty when Herdr starts, when you switch layouts, and when the mod reloads.
- It has buttons only, no keys.
