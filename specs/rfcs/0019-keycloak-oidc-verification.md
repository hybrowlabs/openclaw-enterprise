---
status: Proposed
implementation_status: Not implemented
author: freeqaz
---

# Proposal: Verify Keycloak OIDC sign-in locally and in CI

- **ID:** RFC-0019
- **Owner:** freeqaz (proposal and auth review); CI and Local Setup review: OCE maintainers.
- **Created:** 2026-10-03
- **Last updated:** 2026-10-04 (implementation open as a six-PR stack, see Delivery)
- **RFC PR:** [#1117](https://github.com/openclaw/openclaw-enterprise/pull/1117)
- **Related:** [RFC-0001](0001-oidc-sign-in.md) (generic OIDC sign-in; implementation
  [#790](https://github.com/openclaw/openclaw-enterprise/pull/790));
  [OIDC sign-in guide](../../docs/guides/deploy/oidc-sign-in.md); in-cluster IdP egress note
  [#903](https://github.com/openclaw/openclaw-enterprise/pull/903); token service
  [RFC #924](https://github.com/openclaw/openclaw-enterprise/pull/924).

<a id="problem-and-decision"></a>

## Summary

Keycloak is the only identity provider OCE has ever been checked against, twice by hand and
never by CI. This RFC makes it a **verified** provider: one checked-in realm file feeds a
Keycloak guide page, an opt-in Local Setup sign-in profile that runs a persistent Keycloak in
the k3d cluster, and a CI lane that drives the real browser flow against a pinned Keycloak,
with no change to product authentication and no test-only knobs.

## Motivation

Every automated OIDC test uses the `fakeOidc` fixture
([production-sign-in.mjs](../../tests/helpers/production-sign-in.mjs)), which by its own
description proves OCE against its own reading of OIDC, not any IdP's behaviour. Keycloak was
exercised twice by hand (for #790, and on the dogfood install, finding the defects fixed by
#903 and #806); neither harness is in the repository, that Keycloak lost its realm on every
Pod restart, and the [guide](../../docs/guides/deploy/oidc-sign-in.md) gives Keycloak one
table row. Locally, humans sign in with the generated administrator password, automation uses
the 30-day bootstrap service key, and `occ dev up` has no sign-in option.

## Goals

- **Supported Keycloak**: a documented realm recipe, a pinned major version, and a named list
  of flows CI verifies, all derived from one realm file so the guide cannot drift from the
  tests.
- **Local sign-in**: one environment variable gives the Kubernetes-only Local Setup install a
  Keycloak that survives restarts, with the development administrator attached, so browser
  sessions are short-lived and the password serves recovery only.
- **CI**: a hermetic lane with a digest-pinned Keycloak, a real browser and deadline-bounded
  waits, runnable on a developer host.

## Non-goals

- IdP-issued credentials for API clients (bearer tokens, token exchange, client credentials,
  device flow). Bearer authentication stays disabled
  ([auth/index.ts](../../apps/controller/src/auth/index.ts), `verify`); short-lived machine
  credentials are RFC #924's territory.
- Claim mapping, just-in-time accounts, RP-initiated or back-channel logout, runtime
  discovery, private-key client authentication: RFC-0001's non-goals stand.
- New chart surface: no IdP CA value, no egress port knob, no relaxed endpoint rules. The
  in-cluster egress workaround stays a documented extra NetworkPolicy.
- Relaxing the OIDC and native-admin exclusivity, for development included: OIDC supports
  host-only cookies only
  ([\_helpers.tpl](../../deploy/helm/openclaw-enterprise/templates/_helpers.tpl)), a
  cookie-scope decision (RFC-0007, RFC-0001).
- Keycloak as a production recipe: `start-dev` and the dev-file database are development
  tooling; the guide says so.
- Verifying Auth0, Okta or Entra ID, or changing RFC-0001's status.

<a id="design"></a>

## Proposal

### One realm file

`tests/fixtures/keycloak/realm-oce.json` is a hand-edited Keycloak realm export that the
launcher and the lane import unchanged: realm `oce`; one confidential client `oce-console`
with the authorization-code flow only, PKCE `S256` required, no implicit or direct grants, no
audience mapper and one redirect URI; and users `alice` and `carol` with fixed IDs, so their
`sub` values are known. It contains no secret: the redirect URI, client secret and user
passwords are `${VAR}` placeholders that `--import-realm` resolves from environment variables
set from per-run values kept in `0600` files. Keycloak 26.7.5 imports an unset placeholder as
its literal text (observed), so the lane and the launcher refuse to start while any
placeholder variable is empty, and readiness reads the client back through the admin API and
fails unless its secret and single redirect URI are the generated values. The image digest
sits beside the realm in `tests/fixtures/keycloak/image.json`, read by both, so one bump
changes both.

### What "supported" means

A guide child page, `docs/guides/deploy/oidc-keycloak.md`, linked from the IdP table, gives
the pinned major version (26), the realm recipe as admin-console steps, where `sub` is shown,
and the constraints the lane enforces:

- The realm's default `RS256` key is 2,048 bits or more.
- The client has no audience mapper: a Keycloak ID token's `aud` is the client ID by default,
  and OCE refuses any other audience.
- `KC_HOSTNAME` is the issuer's origin written without a port; the issuer is
  `${KC_HOSTNAME}/realms/<realm>` and must equal `auth.oidc.issuer` character for character.
- The four endpoints share one DNS host, written without a port, served over HTTPS on 443
  with a certificate the API trusts. The host does not end in `.localhost` when the API runs
  in a Pod, because the controller image resolves such names to loopback.

It ends with the verified-flow table below, keyed by the lane's expected test names, and
links `docs/testing/keycloak.md`, which owns the lane.

### Local Setup sign-in profile

`OCC_DEVELOPMENT_SIGN_IN=keycloak` is read by `occ dev up` in the Kubernetes-only profile
(`OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes`, `OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes`,
`OCC_DEVELOPMENT_SANDBOX_DRIVER=none`): the only one that installs Envoy Gateway and
cert-manager and sets the HTTPS `auth.baseUrl`
([openshell_k3d.go](../../internal/occdev/openshell_k3d.go)) the chart requires for
`auth.oidc`, so no new chart values are needed; every other profile refuses the variable and
says why. It adds:

| Piece        | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keycloak     | Namespace `occ-development-keycloak`: the pinned image running `start-dev --import-realm` with `KC_DB=dev-file` on a PersistentVolumeClaim, the realm as a ConfigMap annotated with its sha256, and generated admin, client and user secrets. Import runs only when the realm is absent, so it survives Pod restarts; a changed realm file produces a warning until `occ dev down` removes the volume. Redirect URI: `<auth.baseUrl>/api/auth/providers/oidc/callback`.                                                                               |
| Name and TLS | `keycloak.occ-dev-<name>.oce.test`, terminated by a dedicated Gateway `keycloak` (the chart's Gateway is untouched) whose Envoy Service is a fixed-name NodePort set through an EnvoyProxy patch: a CoreDNS rewrite to that Service, and a Certificate from the chart's gateway-routing CA Issuer, mirrored to `occ-development-keycloak` for the listener. The API already trusts that root (`NODE_EXTRA_CA_CERTS`); the launcher exports it as `gateway-ca.crt` for the browser.                                                                    |
| Host port    | **New, creation-time:** a k3d `--port 127.0.0.1:443:30443@loadbalancer` publication. k3d fixes port maps at creation, so toggling the profile is `occ dev down` then `occ dev up`; the launcher fails fast on a busy 443 and refuses a cluster created without it.                                                                                                                                                                                                                                                                                    |
| Egress       | The extra API-to-Envoy-Pods NetworkPolicy on target port 10443, as the guide documents for in-cluster IdPs.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Readiness    | Discovery served through `127.0.0.1:443`, trusting only the exported CA, then the admin-API client check above; no wait on the Gateway's Programmed condition, which a NodePort Service may never set.                                                                                                                                                                                                                                                                                                                                                |
| Chart values | Two Helm passes. The first bootstraps as today; the launcher signs in with the administrator password through the Console publication and reads the administrator's user ID. The second upgrades with `auth.oidc.*`, `auth.recoveryUserId` (that ID), `auth.passwordSignIn: recovery-only` and `agentNativeAdmin.enabled: false`. Only then (the attach route answers 409 while OIDC is off) the launcher signs in again as the recovery account and `POST`s `/api/auth/accounts/<id>/providers/oidc` with `alice`'s subject and the account version. |
| Developer    | Startup prints the Console URL, the `alice` password file, the two CAs to import (browser CA for the Console, gateway CA for Keycloak) and the `/etc/hosts` line `127.0.0.1 keycloak.occ-dev-<name>.oce.test`.                                                                                                                                                                                                                                                                                                                                        |

### CI lane

A new lane, `keycloak-oidc`, with one file,
`tests/integration/keycloak-oidc-sign-in.test.mjs`, `prepare.postgres` and
`prepare.keycloak: true`. Keycloak is a tracked resource that cleanup always removes, even
after a failed run.

1. **Start.** Generate a two-day private CA and leaves for `keycloak.oce.localhost` and
   `127.0.0.1` with `openssl`. Unless `dns.lookup` returns exactly `127.0.0.1` for that name
   (a `::1`-first answer against a loopback-only publication is a flake), add the `/etc/hosts`
   line with `sudo -n` and remove it in cleanup; `docs/testing/keycloak.md` records the
   logged answer per host. Reserve a free loopback port; the realm's redirect URI becomes
   `https://127.0.0.1:<port>/api/auth/providers/oidc/callback`. Pull the pinned image through
   `pullImage`'s bounded retry and digest check; run `start-dev --import-realm` with HTTPS on
   the Keycloak leaf, `KC_HOSTNAME=https://keycloak.oce.localhost`, a 1.5 GiB memory limit
   and the HTTPS port published on `127.0.0.1:443` (a busy 443 fails fast). Readiness is the
   discovery issuer plus the client-secret check above, polled under a 180-second deadline.
   Every failure names its step.
2. **Hand over.** The file receives `OCC_TEST_DATABASE_URL`, the issuer, the reserved port,
   the secrets and leaf paths, the container name and `NODE_EXTRA_CA_CERTS=<CA>`, which Node
   reads only at start, so prepare sets it.
3. **Prove.** The test composes the production API in-process (`composeProductionSignIn`)
   on a loopback listener behind the HTTPS reverse proxy
   [console-app.mjs](../../tests/helpers/console-app.mjs) already uses, exported as
   `startHttpsIngress` and bound to the reserved port with the loopback leaf. That origin,
   `https://127.0.0.1:<port>`, is `OCC_AUTH_BASE_URL` and matches the realm's one redirect
   URI. Playwright's Chromium trusts exactly the two leaves through
   `--ignore-certificate-errors-spki-list` and fills Keycloak's real login form; the
   controller reaches the real token and JWKS endpoints with its unmodified transport.
   Requests are observed, not stubbed.

| Verified flow (one named test each)                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery matches the four configured values; the JWKS offers an `RS256` key of 2,048 bits or more with a `kid`.                                                                                                |
| `alice`, attached, signs in (`client_secret_post`): the authorization request carries `scope=openid`, `code_challenge_method=S256`, a nonce and the configured redirect URI; `/console/` loads with a session.  |
| The same with `client_secret_basic`, by recomposing the API with that setting.                                                                                                                                  |
| Adding a higher-priority realm key through the admin API changes the JWKS `kid`; the next sign-in succeeds with no controller restart.                                                                          |
| `carol`, not attached, lands on `/console/?authError=oidc`, is audited `EXTERNAL_IDENTITY_REJECTED`, and no account exists.                                                                                     |
| Console sign-out deletes the OCE session; one click signs `alice` in again without a login form while the Keycloak session lives. Disabling her in Keycloak keeps the OCE session and refuses the next sign-in. |

The `alice` flow is also the real-token proof of the single-audience rule; provider-outage
fail-closed behaviour stays with its `fakeOidc` test.

The lane joins `scripts/ci/test-suites.json`, the `full` group and the Full Integration
matrix at once and runs as its own job on `blacksmith-8vcpu-ubuntu-2404` with a 25-minute
budget, not yet `CI Required`, as [First Agent smoke](../../docs/testing/first-agent-smoke.md)
started. The suite audit lists the expected test names, and a skip fails the lane.

### What changes for credentials

For humans, the Console session is the eight-hour, non-refreshing session RFC-0001 already
gives OIDC sign-in; the change is that Local Setup can use it. Scoping stays OCE IAM on the
attached account; Keycloak decides only who may authenticate. For automation, nothing
changes: bootstrap still writes a 30-day service key, shorter-lived keys come from the
[service-key API](../../docs/reference/authentication/service-api-keys.md) (`expiresIn`),
and IdP-issued machine credentials wait for RFC #924.

### Security and failure

- Every secret is generated per run or install and lives in `0600` files; the realm file
  holds none; the CA lives two days; Keycloak admin credentials never leave the lane or the
  launcher state directory. The lane container runs as root to read its `0600` leaf key.
- No environment-gated behaviour in the controller or the chart: TLS trust uses the
  documented `NODE_EXTRA_CA_CERTS` path, the endpoint rule applies unchanged, and the fetch
  transport is the production one.
- An unready Keycloak, a changed login form, a digest mismatch, a literal placeholder or a
  busy port fails the lane with the step named; cleanup runs regardless.

## Rationale and alternatives

- **Extend `postgres-auth`**: rejected; a 450 MB pull and a JVM start in a `CI Required`
  lane whose tests mock `globalThis.fetch`.
- **Intercepting `fetch`** to reach 443 proves a patched stack; **`unshare -rn`** (as #790)
  fails on Ubuntu 24.04's user-namespace restrictions; **a `*.localhost` launcher name**
  resolves to loopback in the API Pod; **Testcontainers** hides the digest pin and retry
  policy; the **dogfood browser workaround** needs a port-forward and a specially launched
  browser. All rejected.

## Delivery

Six human-gated pull requests, one per task, each based on its parent:

| PR                                                                 | Task                                                                                            | Base  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----- |
| [#1133](https://github.com/openclaw/openclaw-enterprise/pull/1133) | Lane skeleton: realm, image pin, `prepare.keycloak`, lane and job, discovery test, testing page | main  |
| [#1134](https://github.com/openclaw/openclaw-enterprise/pull/1134) | Real browser sign-in: `alice` (`post`, `basic`), `carol` refused; `startHttpsIngress`           | #1133 |
| [#1135](https://github.com/openclaw/openclaw-enterprise/pull/1135) | Key rotation, sign-out, one-click re-sign-in, disabled user; runner hosts behaviour recorded    | #1134 |
| [#1136](https://github.com/openclaw/openclaw-enterprise/pull/1136) | Keycloak guide page, IdP table link, nav and cheat sheet                                        | #1135 |
| [#1137](https://github.com/openclaw/openclaw-enterprise/pull/1137) | Launcher: persistent Keycloak, 443 publication, Gateway, DNS, TLS, egress, `down` cleanup       | #1133 |
| [#1138](https://github.com/openclaw/openclaw-enterprise/pull/1138) | Launcher: second Helm pass, attach, printed instructions, Local Setup docs                      | #1137 |

## Verification record (2026-10-04)

- **CI:** the stack merged on `main` `ad9eda703` (branch `ci/keycloak-e2e`) ran the full
  workflow, run 37166912213: `Keycloak OIDC` 6 passed, 0 skipped (artifact checked);
  `CI Required`, both PostgreSQL OIDC suites, Console Browser and the k3d lanes green. The
  runner resolved `keycloak.oce.localhost` to `[127.0.0.1, ::1]`, so the `sudo -n` hosts path
  ran for the first time and worked; Keycloak started in 20.6 s.
- **Developer host:** the lane through the CI entry points, 6/6 on three consecutive clean
  runs in a private network namespace (nginx holds 443). Forced failures (busy 443, bad
  digest, extra placeholder) named their step and left nothing.
- **Dogfood, following the new guide:** its Keycloak moved to the pinned image with
  `--import-realm`, so it is restart-proof. With OIDC enabled, a member attached to `carol`
  holding one Namespace-read role signed in through Keycloak's form, read the Namespace (200)
  and got 403 on every write and admin read; the member's password sign-in returned 401
  (recovery-only), the administrator's 200; `alice` got an eight-hour `__Host-` session,
  issued a one-day service key that worked until revoked, signed out and signed in again with
  one click. Dogfood was then restored to password-only.
- **Launcher, cluster side only:** the manifests and second-pass values rendered by the
  launcher's own functions were applied to dogfood: the EnvoyProxy patch produced the
  fixed-name NodePort Service, `node:30443` served discovery, the API Pod reached Keycloak
  through the CoreDNS rewrite and the 10443 policy, `alice` signed in, the realm survived a
  Keycloak Pod delete, and deleting the Namespace left nothing behind.
- **Not verified anywhere:** the k3d `127.0.0.1:443` publication and its check, the
  launcher's host-side discovery client, a complete `occ dev up` and `occ dev down` with the
  profile (no available host has 443 free), a human browser with the two imported CAs and the
  `/etc/hosts` line (all browser checks were headless), the Full Integration `all` aggregate
  (its matrix entry is covered by `ci-impact.test.mjs`), other IdPs and Keycloak versions.

## Risks

- **Keycloak cost and flakiness.** About 450 MB from `quay.io`, 20-50 s to start, ~1 GB of
  memory. Mitigations: digest pin, `pullImage` retry, bounded readiness, a dedicated
  non-required lane.
- **Login-form scraping.** Playwright selectors and the "Account is disabled" text are tied
  to the pinned version; a digest bump is a reviewed change.
- **Port 443 on developer hosts.** The lane and the profile both take loopback 443, so a host
  runs one at a time and neither beside a local web server; both fail fast.
- **Realm drift.** Import runs only on an empty database, so a changed realm file needs
  `occ dev down`; the launcher warns when it sees an older realm hash.

## Open questions

| Question                                                                        | Owner       | Proposed default                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| When does the lane become `CI Required`?                                        | freeqaz     | After two weeks of green runs on `main` with no infrastructure failure; promotion is a `ci.yml` `pr-safe` matrix entry plus the `test-suites.json` `ci`-group edit.                                                                 |
| Does the dogfood install keep OIDC on?                                          | freeqaz     | Its Keycloak is now restart-proof and the enable and disable recipes are recorded. OIDC on costs embedded-Agent browser chat (`agentNativeAdmin.enabled: false`); the launcher profile needs host 443, which another service holds. |
| Who runs the launcher profile end to end before #1137 and #1138 land?           | freeqaz     | A host with `127.0.0.1:443` free runs `occ dev up` with the profile, signs in as `alice` from a real browser, restarts the Keycloak Pod, and runs `occ dev down`.                                                                   |
| Is a chart-topology Keycloak lane (k3d, NetworkPolicy, Pod DNS) worth its cost? | maintainers | Not now: the launcher profile gives the same topology on demand.                                                                                                                                                                    |
| Keycloak version policy                                                         | maintainers | Pin 26.x by digest; bump with the other pinned images, re-checking the login selectors.                                                                                                                                             |
