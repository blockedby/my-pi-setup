# Browser Chrome security notes

Chrome DevTools access is powerful. A client connected to the debug endpoint can inspect pages and control the browser.

## Persistent headed browser

The headed browser may contain live accounts, cookies, local/session storage, passwords, private pages, and internal services.

Rules for agents:

- Do not inspect, dump, print, or exfiltrate cookies, tokens, local storage, or password data unless explicitly requested.
- Do not use headed mode for public/anonymous tasks.
- Do not perform account-changing or destructive actions without explicit user direction.
- Close only tabs/pages opened for the task; do not close the entire persistent browser.

## Network exposure

Debug endpoints can be configured for localhost, LAN, Tailscale, or an SSH tunnel. Choose the exposure based on your threat model.

Useful variables:

```bash
BROWSER_CHROME_HEADED_URL=http://127.0.0.1:9233
BROWSER_CHROME_HEADED_BIND_ADDRESS=127.0.0.1
BROWSER_CHROME_HEADED_PORT=9233

BROWSER_CHROME_HEADLESS_START_COMMAND='ssh desktop-host /path/to/browser-chrome/scripts/open-headless.sh'
BROWSER_CHROME_HEADLESS_CLOSE_COMMAND='ssh desktop-host /path/to/browser-chrome/scripts/close-headless.sh "$BROWSER_CHROME_ID"'
```

For LAN/Tailscale/SSH-tunnel access, set reachable URLs and bind addresses deliberately.

## Headless browser

Headless instances are disposable. They use temporary profiles and unique ports, and should be closed after use. They may run locally or on a remote host; if remote, configure both start and close commands so cleanup still happens.
