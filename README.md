# design-variant-picker

Human-in-the-loop design picker for [OpenCode](https://opencode.ai). The agent generates HTML design variants; you pick one — or ask for more — from a live browser grid. Regenerations are produced by **your current conversation's model**. No extra LLM, no API keys.

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

The agent calls the `variant_picker` tool, a browser tab opens with a grid of variants, and you drive from there:

- **Click a tile** to select it.
- **Generate variants of this** → tiles show skeletons; the agent produces a new batch (riffing on your selection + any notes) and the **same tab updates in place**. Repeat as many times as you want.
- **Use this** → hands the chosen variant back to the agent; the conversation continues.

Type freeform notes to steer each round, and pick how many variants you want next from the **Next:** dropdown (default 9).

## How it works

```
agent ──variant_picker(variants)──▶ local picker tab (you)
  ▲                                        │
  │  decision: use | regenerate | abandoned│
  └────────────────────────────────────────┘
       on "regenerate", the agent makes the next batch
       and re-calls with the same sessionToken → same tab
```

- The tool **blocks** until you act, then returns `use` (with your pick), `regenerate` (the agent generates the next batch itself), or `abandoned` (you closed the tab — the agent never hangs).
- Variants render in sandboxed `<iframe>`s. The server is bound to `127.0.0.1` and every request needs a per-session random token.
- Closing the tab cancels gracefully (a beacon resolves the call immediately).

## Remote access (optional)

To open the picker from another machine, the agent can pass `remote: true`. This exposes the picker through an anonymous [Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) — requires [`cloudflared`](https://github.com/cloudflare/cloudflared) on your `PATH`. Falls back to localhost if it's missing.

## License

MIT
