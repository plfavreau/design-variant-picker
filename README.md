# design-variant-picker

A design picker for [OpenCode](https://opencode.ai) that keeps you in the loop. The agent builds HTML design variants, and you pick one (or ask for more) from a live grid in your browser. New variants are made by the model you're already chatting with, so there's **no vision LLM required**. No extra model, no API keys.

## Demo

<p align="center">
  <video src="https://github.com/plfavreau/design-variant-picker/raw/main/assets/demo.mp4" controls muted autoplay loop></video>
</p>

## Install

Add it to your `opencode.json`:

```json
{
  "plugin": ["design-variant-picker"]
}
```

That's it. Restart OpenCode (the tool binds at session start, so open a **new** session).

## Use

Just ask:

> Generate 9 variants of this pricing card and let me pick.

The agent calls the `variant_picker` tool. A browser tab opens **right away with loading skeletons** (no blank screen to stare at), then fills in with the variants. From there you drive:

- **Click a tile** to select it.
- **Generate variants of this**: the tiles show skeletons, the agent makes a new batch based on your pick and any notes, and the **same tab updates in place**. Repeat as many times as you want.
- **Use this**: hands the chosen variant back to the agent, and the chat keeps going.

You can type notes to guide each round, and choose how many variants you want next from the **Next:** dropdown (default 9).

## How it works

```
agent ──variant_picker(variants)──▶ local picker tab (you)
  ▲                                        │
  │  decision: use | regenerate | abandoned│
  └────────────────────────────────────────┘
       on "regenerate", the agent makes the next batch
       and re-calls with the same sessionToken → same tab
```

- To skip the first wait, the agent opens the tab with an empty batch (`open`) so the skeletons show up immediately, then fills it with the first batch.
- The tool **waits** until you act, then returns `use` (with your pick), `regenerate` (the agent makes the next batch itself), or `abandoned` (you closed the tab, so the agent never hangs).
- Variants render in sandboxed `<iframe>`s. The server is bound to `127.0.0.1` and every request needs a random per-session token.
- Closing the tab cancels cleanly (a beacon resolves the call right away).

## Remote access (optional)

To open the picker from another machine, the agent can pass `remote: true`. This serves the picker through an anonymous [Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/), which needs [`cloudflared`](https://github.com/cloudflare/cloudflared) on your `PATH`. If it's missing, it falls back to localhost.

## License

MIT
