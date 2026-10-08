# Keycloak OIDC lane

The `keycloak-oidc` lane checks OIDC sign-in against a real, digest-pinned Keycloak
instead of the `fakeOidc` fixture. It runs as the `Keycloak OIDC` job in the
[CI workflow](../../.github/workflows/ci.yml) in full-mode pull request CI and on pushes to
`main`, and in the Full Integration `all` run. It is **not** a `CI Required`
dependency yet. The proposed design is RFC-0019 ([#1117](https://github.com/openclaw/openclaw-enterprise/pull/1117)).

## What it runs

| Piece     | Source                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------- |
| Realm     | [`tests/fixtures/keycloak/realm-oce.json`](../../tests/fixtures/keycloak/realm-oce.json)        |
| Image pin | [`tests/fixtures/keycloak/image.json`](../../tests/fixtures/keycloak/image.json)                |
| Server    | [`scripts/ci/keycloak.mjs`](../../scripts/ci/keycloak.mjs), started by `prepare.keycloak: true` |
| Lane      | [`scripts/ci/test-suites/keycloak-oidc.json`](../../scripts/ci/test-suites/keycloak-oidc.json)  |
| Tests     | [`keycloak-oidc-sign-in.test.mjs`](../../tests/integration/keycloak-oidc-sign-in.test.mjs)      |

The realm is `oce` with one confidential client, `oce-console`: authorization code
only, PKCE `S256` required, one redirect URI and no audience mapper. Users `alice`
and `carol` have fixed IDs, so their `sub` values are known. The realm file holds
no secret: the client secret, redirect URI and user passwords are `${VAR}`
placeholders that `--import-realm` fills from the server's environment.

Keycloak imports an unset placeholder as its literal text. This was observed with
the pinned 26.7.5 image: an unset `OCE_KEYCLOAK_CLIENT_SECRET` produced the client
secret `${OCE_KEYCLOAK_CLIENT_SECRET}`. Preparation therefore refuses to start
while any placeholder variable is empty, and readiness fails if the admin API
shows a placeholder or any secret other than the generated one.

## Preparation

`node scripts/ci/prepare.mjs --lane keycloak-oidc --state <state-file>` runs these
steps. A failure names its step (`Keycloak <step> step failed: ...`).

1. **image**: pull the pinned image through the bounded `pullImage` retry and
   verify the repository digest.
2. **port**: fail if anything accepts connections on `127.0.0.1:443`, then
   reserve a free loopback port for the test's HTTPS Console origin. The realm's
   redirect URI is `https://127.0.0.1:<port>/api/auth/providers/oidc/callback`.
3. **placeholders**: generate the client secret, user passwords and Keycloak
   administrator password into a `0600` `secrets.json`; refuse an unset placeholder.
4. **certificates**: a two-day private CA with leaves for `keycloak.oce.localhost`
   and `127.0.0.1`, made with `openssl`.
5. **hosts**: unless `keycloak.oce.localhost` resolves to exactly `127.0.0.1`,
   append `127.0.0.1 keycloak.oce.localhost # openclaw-ci keycloak <container>` to
   `/etc/hosts` with `sudo -n`. A `::1` answer against the IPv4-only publication flakes.
6. **start**: `start-dev --import-realm` with HTTPS on the Keycloak leaf,
   `--hostname=https://keycloak.oce.localhost`, a 1.5 GiB memory limit and the
   HTTPS port published on `127.0.0.1:443`. Secrets reach the container through
   its environment, never the command line.
7. **readiness**: within 180 seconds, discovery must return the issuer
   `https://keycloak.oce.localhost/realms/oce`, and the admin API must show the
   generated client secret and the reserved redirect URI. The container's last
   log lines are printed on failure.

The test process receives `OCC_TEST_KEYCLOAK_*` paths and values and
`NODE_EXTRA_CA_CERTS` pointing at the lane CA. `scripts/ci/cleanup.mjs` removes the
container, the hosts line it added and the private directory, also after a failed
preparation.

## Verified flows

| Test                                                                                              | Proves                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Discovery matches the configured endpoints and the JWKS offers an RS256 key of 2,048 bits or more | Production OIDC configuration parsing accepts Keycloak's issuer and endpoints; the controller transport reads the JWKS. |

The suite audit lists the expected test; a skip or a missing case fails the lane.

## Run it on a developer host

You need Docker, `openssl`, Node.js 24 and a free `127.0.0.1:443`. Rootless engines
must be allowed to publish port 443. Hold one Keycloak at a time per host:

```sh
state="$PWD/.ci-state/keycloak-oidc.json"
node scripts/ci/prepare.mjs --lane keycloak-oidc --state "$state" &&
  node scripts/ci/run-tests.mjs run keycloak-oidc --state "$state" --results "$PWD/.ci-state/results.json"
node scripts/ci/cleanup.mjs --state "$state"
```

Without passwordless `sudo`, add the hosts line yourself before preparing, and
remove it afterwards:

```sh
echo '127.0.0.1 keycloak.oce.localhost' | sudo tee -a /etc/hosts
```

The line only helps when `/etc/hosts` is read before other resolvers. If
`nsswitch.conf` lists `resolve` first, systemd-resolved answers `*.localhost` with
`::1` as well and the hosts step fails.

## Troubleshooting

| Failure                             | Meaning                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Keycloak image step failed`        | The registry refused the pinned digest or the pull outlived its retries.                       |
| `Keycloak port step failed`         | Another service, or another Keycloak lane, holds `127.0.0.1:443`.                              |
| `Keycloak placeholders step failed` | The realm gained a placeholder that preparation does not set.                                  |
| `Keycloak hosts step failed`        | `sudo -n` was refused or the resolver still answers with another address.                      |
| `Keycloak readiness step failed`    | Read the printed container log; a literal placeholder means the import read an unset variable. |

To bump Keycloak, change `image.json` to a new 26.x digest and rerun the lane; the
login-form selectors used by later sign-in tests are tied to that version.

## Local launcher coverage

The `dev-up-k3d` lane owns two additional cases in
[`dev-up-k3d-real.test.mjs`](../../tests/integration/dev-up-k3d-real.test.mjs).
They run through the CLI-only lane, outside automatic CI and Full Integration
dispatch. Prepare the CLI and Chromium with the
[local installation setup](kubernetes.md#local-kubernetes-installation) first.

```sh
OCC_TEST_DEV_UP_K3D_REAL=1 node --test tests/integration/dev-up-k3d-real.test.mjs
```

Run only on an
owned disposable engine with enough capacity for the launcher and its image
builds, free and bindable host loopback port 443, and prepared Playwright Chromium
with its sandbox supported. Do not run beside the standalone Keycloak CI fixture.
The cases use `occ dev up` with Kubernetes compute/control plane and sandbox
`none`; they preserve enforcing NetworkPolicies and use generated fixture
credentials only. They cover HTTPS discovery, Alice attached to the development
administrator, recovery-password success, ordinary-password denial, fresh login with a changed password
after a Keycloak Pod restart, and `occ dev down`. The failure case refuses the
second Helm command and first owned cluster deletion to verify rollback and
retained state, then retries real cleanup. Failed cleanup preserves that state.
Browser DNS mappings and certificate pins are process-local; this automation does
not verify a human browser's CA import or manual hosts-file setup.
