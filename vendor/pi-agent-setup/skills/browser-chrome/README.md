# browser-chrome skill

A portable Agent Skills package for using Chrome through Chrome DevTools MCP.

- Skill name: `browser-chrome`
- MCP wrapper script: `scripts/mcp.sh`
- Control/session MCP script: `scripts/control-mcp.sh`
- MCP package: `chrome-devtools-mcp@latest`

## Runtime requirements

- Google Chrome or Chromium.
- Node.js with `npm`/`npx` available.
- `chrome-devtools-mcp@latest` reachable via:

  ```bash
  npx -y chrome-devtools-mcp@latest --help
  ```

- Pi with [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) installed and enabled.

## Install for Pi locally

```bash
scripts/install-local.sh
```

This installs:

- the skill to `~/.pi/agent/skills/browser-chrome`;
- three MCP entries to `~/.pi/agent/mcp.json` that point directly at the installed skill scripts:
  - `browser-chrome-control`
  - `browser-chrome-headed`
  - `browser-chrome-headless`

Restart Pi or reconnect MCP after installation.

## Install with skills CLI

The skill itself can be installed with the Vercel Labs `skills` CLI:

```bash
npx skills add ./browser-chrome-skill --skill browser-chrome --agent pi --global --yes
```

The skills CLI installs the skill instructions. Run `scripts/install-local.sh` when you also want MCP entries that point directly at the installed skill scripts.

## Modes

### Headless

Use for public, anonymous, local, simple, and parallel browser checks. First call `browser_chrome_acquire_session` on `browser-chrome-control` with `form: "headless-disposable"`, then use the returned `browser-chrome-headless` guidance. Each DevTools MCP run gets a fresh profile and unique port. The MCP wrapper closes it after use.

### Headed persistent

Use for tasks requiring login/logout, current auth, saved sessions, saved passwords, extensions, or persistent profile data. First call `browser_chrome_acquire_session` on `browser-chrome-control` with `form: "headed-persistent"`, or `browser_chrome_assert_persistent` for validation. The control MCP takes an advisory lease, delegates open/reuse to `scripts/open-headed.sh`, and returns guidance to use `browser-chrome-headed` for `chrome_devtools_*` actions. `browser_chrome_release` releases only the lease; it does not close the whole headed browser.

## Important environment variables

```bash
# Headed browser endpoint used by MCP. Headed persistent ports are validated to 9200-9300.
BROWSER_CHROME_HEADED_URL=http://127.0.0.1:9233

# Local headed browser launch settings.
BROWSER_CHROME_HEADED_PORT=9233
BROWSER_CHROME_HEADED_BIND_ADDRESS=127.0.0.1
BROWSER_CHROME_HEADED_USER_DATA_DIR=$HOME/.cache/browser-chrome/headed-profile
BROWSER_CHROME_HEADED_PROFILE_DIRECTORY=Default

# Optional custom start command for remote headed hosts.
BROWSER_CHROME_HEADED_START_COMMAND='ssh desktop-host /path/to/browser-chrome/scripts/open-headed.sh'
BROWSER_CHROME_HEADED_LOCAL_START=0

# Optional custom start/close commands for remote headless hosts.
# The start command must print: OPEN mode=headless id=<id> url=<debug-url>
BROWSER_CHROME_HEADLESS_START_COMMAND='ssh desktop-host /path/to/browser-chrome/scripts/open-headless.sh'
BROWSER_CHROME_HEADLESS_CLOSE_COMMAND='ssh desktop-host /path/to/browser-chrome/scripts/close-headless.sh "$BROWSER_CHROME_ID"'
BROWSER_CHROME_HEADLESS_LOCAL_START=0

# Chrome binary, Node runtime for control MCP, and MCP package.
BROWSER_CHROME_BIN=google-chrome-stable
BROWSER_CHROME_NODE=node
BROWSER_CHROME_MCP_PACKAGE=chrome-devtools-mcp@latest
```

For LAN/Tailscale/SSH-tunnel use, set headed and headless URLs/start commands deliberately. No wrapper commands need to be installed into `~/.local/bin`; MCP entries can point directly at the installed skill scripts.
