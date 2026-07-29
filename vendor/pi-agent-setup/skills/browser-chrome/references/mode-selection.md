# Browser Chrome mode selection

Use the cheapest safe browser mode for the task.

## Headless disposable mode

Choose headless when the task does not need persistent user state:

- public pages;
- simple fetches;
- screenshots;
- responsive/mobile checks;
- local UI smoke tests without auth;
- parallel agent tasks.

Headless mode opens a fresh Chrome instance with a temporary profile and unique port. Close it after use. Do not share it across unrelated agents.

## Headed persistent mode

Choose headed when the task needs persistent state:

- current authenticated sessions;
- login/logout flows;
- saved passwords or autofill;
- extensions;
- private internal/external services;
- behavior in the user's real browser profile.

Headed mode reuses a configured Chrome profile. Always check if the browser is already reachable before opening it. If the profile appears locked/running but the DevTools endpoint is not reachable, report the blocker instead of launching another Chrome with the same profile.

## Remote hosts

Both headed and headless Chrome may run on another machine, with the DevTools port exposed through LAN, Tailscale, or an SSH tunnel.

Headed examples:

```bash
# Same machine
export BROWSER_CHROME_HEADED_URL=http://127.0.0.1:9233

# Tailscale or LAN host
export BROWSER_CHROME_HEADED_URL=http://my-desktop.tailnet-name.ts.net:9233

# Remote can ask another host to start headed Chrome
export BROWSER_CHROME_HEADED_START_COMMAND='ssh desktop-host /path/to/browser-chrome/scripts/open-headed.sh'
export BROWSER_CHROME_HEADED_LOCAL_START=0
```

Headless examples:

```bash
# Remote starts a disposable headless browser and prints: OPEN mode=headless id=<id> url=<debug-url>
export BROWSER_CHROME_HEADLESS_START_COMMAND='ssh desktop-host /path/to/browser-chrome/scripts/open-headless.sh'
export BROWSER_CHROME_HEADLESS_CLOSE_COMMAND='ssh desktop-host /path/to/browser-chrome/scripts/close-headless.sh "$BROWSER_CHROME_ID"'
export BROWSER_CHROME_HEADLESS_LOCAL_START=0
```

When an SSH tunnel is used, the start command should create or rely on the tunnel and print the tunnel-local DevTools URL that the agent can reach.
