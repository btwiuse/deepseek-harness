# Agent Note: Allow --host 0.0.0.0 for proxy-fronted web deployments

Status: implemented

English | [中文](2026-08-14-allow-all-interfaces-web-bind.zh.md)

## Problem

`dsh web` refused `--host 0.0.0.0` outright ("intentionally not supported yet for safety") and bound only 127.0.0.1 by default, so the only supported public exposure was a reverse tunnel fronting a loopback listener. Platform-native public domains do not work that way: a proxy such as Railway's connects to the container's private IP on `$PORT`, and with nothing listening on that interface the public domain answers 502 even though the app is up and reachable on loopback.

## Decision

`web-startup` now accepts `--host 0.0.0.0` and binds every interface. The /api browser-trust fences are unchanged and still gate access — Host, Origin, and the privileged loopback pin apply exactly as before unless `--dev` disables them ([browser-trust boundary](../architecture/2026-07-28-api-browser-trust-boundary.md)). The shipped `Dockerfile` now starts `dsh web --dev --host 0.0.0.0`, so the platform proxy reaches the container; `--dev` stays because a proxy-fronted deployment cannot present a loopback Host to the loopback-pinned endpoints.

Tests updated with the behavior: `startup.spec.ts` asserts `--host 0.0.0.0` publishes the all-interfaces host, the built-bin e2e rejection assertion is removed, and `smoke-real.e2e.ts` spawns `web --host 0.0.0.0` and fetches the SPA over both loopback and the machine's LAN address.

## Alternatives considered

**A TCP relay in the container.** `dsh` stays on 127.0.0.1 and a second process forwards 0.0.0.0:$PORT to it. Rejected: it adds a moving part and port juggling, and once the operator explicitly asks for all-interfaces binding the relay buys no extra safety over the fences.

**Keep loopback and mandate a reverse tunnel.** Rejected: every platform-native domain (Railway, Fly) is then permanently dependent on a third-party tunnel; the explicit all-interfaces flag is the smaller, documented surface.

**Accept 0.0.0.0 but only warn.** Rejected: the fences already gate /api; a warning is noise, not protection, once the operator named the host.

## Consequences

A proxy-fronted deployment now works with one flag: `dsh web --dev --host 0.0.0.0`, or `--host 0.0.0.0` plus `--trusted-host`/`--trusted-origin` when `--dev` is not acceptable. The security posture is the operator's explicit choice: binding all interfaces exposes the app to the network, and without `--dev` the loopback-pinned /api endpoints still require a loopback Host or a declared origin. The `dsh web:` ready line still prints the loopback URL, plus LAN candidates when bound to 0.0.0.0.
