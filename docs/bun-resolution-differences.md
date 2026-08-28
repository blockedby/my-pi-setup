# Bun migration resolution comparison

This comparison inventories the union of the removed root/nine-extension lockfiles plus immutable `vendor/pi-codex/package-lock.json` against the final root `bun.lock`. Names and version sets are compared rather than physical paths because Bun hoists/deduplicates one workspace graph while the old independent roots contained duplicate nested copies.

All direct root, extension, and parent-owned vendor-boundary dependency versions were preserved. Explicit overrides also retain the old Effect beta, Effect TSGO, Claude SDK, Rolldown/Vite, native binding, and other previously resolved transitive versions where one compatible workspace-wide version exists. Most changed sets below are deduplication: Bun selected one version that already existed in the legacy union.

Three transitive families contain a new version: Bun's peer resolution selects `@modelcontextprotocol/sdk@1.30.0` despite the reviewed `1.29.0` override request; that graph selects `content-type@2.1.0`, and the unified jsdom/Pi graph selects `undici@7.29.0`. These are exact lock-pinned differences, not floating launch-time resolution. Deterministic extension/browser/installer tests and the isolated frozen runtime install cover them. Legacy-only type packages belong to immutable vendor devDependencies, while the remaining legacy-only packages were dependencies of duplicate versions removed by Bun deduplication.

406 legacy package names; 393 Bun package names; 355 exact version-set matches; 38 changed version sets; 13 legacy-only; 0 Bun-only.

## Changed version sets

- `@anthropic-ai/sdk`: legacy `0.114.0, 0.91.1` → Bun `0.91.1`
- `@aws-sdk/core`: legacy `3.974.11, 3.976.0` → Bun `3.976.0`
- `@aws-sdk/credential-provider-env`: legacy `3.972.37, 3.972.60` → Bun `3.972.60`
- `@aws-sdk/credential-provider-http`: legacy `3.972.39, 3.972.62` → Bun `3.972.62`
- `@aws-sdk/credential-provider-ini`: legacy `3.972.41, 3.973.5` → Bun `3.973.5`
- `@aws-sdk/credential-provider-login`: legacy `3.972.41, 3.972.67` → Bun `3.972.67`
- `@aws-sdk/credential-provider-node`: legacy `3.972.42, 3.972.71` → Bun `3.972.71`
- `@aws-sdk/credential-provider-process`: legacy `3.972.37, 3.972.60` → Bun `3.972.60`
- `@aws-sdk/credential-provider-sso`: legacy `3.972.41, 3.973.4` → Bun `3.973.4`
- `@aws-sdk/credential-provider-web-identity`: legacy `3.972.41, 3.972.66` → Bun `3.972.66`
- `@aws-sdk/eventstream-handler-node`: legacy `3.972.16, 3.972.29` → Bun `3.972.29`
- `@aws-sdk/middleware-eventstream`: legacy `3.972.12, 3.972.24` → Bun `3.972.24`
- `@aws-sdk/middleware-websocket`: legacy `3.972.19, 3.972.42` → Bun `3.972.42`
- `@aws-sdk/nested-clients`: legacy `3.997.34, 3.997.9` → Bun `3.997.34`
- `@aws-sdk/signature-v4-multi-region`: legacy `3.996.27, 3.996.41` → Bun `3.996.41`
- `@aws-sdk/types`: legacy `3.973.8, 3.974.2` → Bun `3.974.2`
- `@aws-sdk/util-locate-window`: legacy `3.965.5, 3.965.8` → Bun `3.965.8`
- `@aws-sdk/xml-builder`: legacy `3.972.24, 3.972.36` → Bun `3.972.36`
- `@aws/lambda-invoke-store`: legacy `0.2.4, 0.3.0` → Bun `0.3.0`
- `@babel/runtime`: legacy `7.29.2, 7.29.7` → Bun `7.29.7`
- `@modelcontextprotocol/sdk`: legacy `1.29.0` → Bun `1.30.0`
- `@protobufjs/utf8`: legacy `1.1.1, 1.1.2` → Bun `1.1.2`
- `@smithy/core`: legacy `3.24.3, 3.29.8` → Bun `3.29.8`
- `@smithy/credential-provider-imds`: legacy `4.3.3, 4.4.13` → Bun `4.4.13`
- `@smithy/fetch-http-handler`: legacy `5.4.3, 5.6.10` → Bun `5.6.10`
- `@smithy/signature-v4`: legacy `5.4.3, 5.6.9` → Bun `5.6.9`
- `@smithy/types`: legacy `4.14.2, 4.16.1` → Bun `4.16.1`
- `@types/node`: legacy `22.19.19, 25.6.0, 26.1.1` → Bun `26.1.1`
- `content-type`: legacy `1.0.5, 2.0.0` → Bun `1.0.5, 2.1.0`
- `entities`: legacy `6.0.1, 8.0.0` → Bun `8.0.0`
- `gaxios`: legacy `7.1.4, 7.3.0` → Bun `7.3.0`
- `google-auth-library`: legacy `10.6.2, 10.9.1` → Bun `10.9.1`
- `lru-cache`: legacy `11.3.5, 11.4.0` → Bun `11.4.0`
- `parse5`: legacy `7.3.0, 8.0.1` → Bun `8.0.1`
- `typebox`: legacy `1.1.33, 1.3.7` → Bun `1.3.7`
- `undici`: legacy `7.25.0, 8.8.0, 8.9.0` → Bun `7.29.0, 8.9.0`
- `undici-types`: legacy `6.21.0, 7.19.2, 7.25.0, 8.3.0` → Bun `8.3.0`
- `ws`: legacy `8.21.0, 8.21.1` → Bun `8.21.1`

## Legacy-only package names

- `@aws-crypto/crc32`
- `@nodable/entities`
- `@stablelib/base64`
- `@types/jsdom`
- `@types/tough-cookie`
- `@types/turndown`
- `fast-sha256`
- `fast-xml-builder`
- `fast-xml-parser`
- `path-expression-matcher`
- `standardwebhooks`
- `strnum`
- `xml-naming`

There are no Bun-only package names in the root workspace comparison.
