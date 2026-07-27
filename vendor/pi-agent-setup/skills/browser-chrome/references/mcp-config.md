# Browser Chrome MCP config

The recommended Pi MCP setup has one control/session server plus two DevTools servers. Agents should call `browser-chrome-control` first, then use the returned guidance to choose `browser-chrome-headed` or `browser-chrome-headless` for actual `chrome_devtools_*` actions.

```json
{
  "mcpServers": {
    "browser-chrome-control": {
      "command": "browser-chrome-control-mcp",
      "args": [],
      "lifecycle": "lazy"
    },
    "browser-chrome-headed": {
      "command": "browser-chrome-mcp",
      "args": ["headed"],
      "lifecycle": "lazy",
      "env": {
        "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS": "1"
      }
    },
    "browser-chrome-headless": {
      "command": "browser-chrome-mcp",
      "args": ["headless"],
      "lifecycle": "lazy",
      "idleTimeout": 1,
      "env": {
        "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS": "1"
      }
    }
  }
}
```

`browser-chrome-control` exposes these policy tools only:

- `browser_chrome_status`
- `browser_chrome_acquire_session`
- `browser_chrome_assert_persistent`
- `browser_chrome_release`

It is not a full `chrome-devtools-mcp` proxy. For browser actions, use the DevTools MCP server named in the control tool result.

`browser-chrome-mcp` calls `npx -y chrome-devtools-mcp@latest` by default.

Override package or npx command with:

```bash
export BROWSER_CHROME_MCP_PACKAGE=chrome-devtools-mcp@latest
export BROWSER_CHROME_NPX=npx
```

Run `scripts/install-local.sh` to install the skill and merge these MCP entries into `~/.pi/agent/mcp.json`. The installer preserves `browser-chrome-headed` and `browser-chrome-headless` while adding/updating `browser-chrome-control`.
