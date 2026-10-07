import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import { validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import {
  PostgresHumanAuthentication,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";

const authSecret = "deployer-revision-read-postgres-auth-secret-minimum-32";
const byId = (left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

test(
  "a deploy grants its deployer exact read of the admitted revision, audited and removed with the Agent",
  requiresPostgres,
  async (t) => {
    // Account provisioning as the development PostgreSQL composition wires it, so an
    // administrator can enrol people through POST /api/auth/accounts.
    const accounts = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    t.after(() => accounts.end());
    const accountState = new PostgresPlatformState(accounts);
    const provisionAuthAccount = async (seed, auditEvent, prepared) => {
      const installation = await accountState.loadInstallation();
      validateAuthAccountPrincipalSeed(
        seed,
        await accountState.loadNativeIAMState(installation.id),
        installation.id,
      );
      await new PostgresHumanAuthentication(
        accountState,
        installation.id,
        betterAuthIssuer(installation.id),
      ).provisionPasswordAccount(prepared, seed, auditEvent);
    };
    const { pool, app, inject, deployAgent } = await createPostgresAgentApp(t, {
      label: "deployer-revision-read",
      authSecret,
      appOptions: { provisionAuthAccount },
    });
    // v1 is deployed by the bootstrap administrator, whose Installation-wide Role already
    // reads every revision.
    const { namespace, secretRef, agent, revision: first } = await deployAgent("Deployer read");
    const policyPath = `/namespaces/${namespace.id}/iam`;

    // Two people enrolled with no grant, as the IAM guide's "Add a person" does.
    async function person(name) {
      const email = `${name}-${randomUUID()}@example.com`;
      const password = `generated-password-${randomUUID()}`;
      const created = await inject("POST", "/api/auth/accounts", { email, password, name });
      assert.equal(created.statusCode, 201, created.body);
      const signIn = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        payload: JSON.stringify({ email, password }),
      });
      assert.equal(signIn.statusCode, 200, signIn.body);
      const setCookie = signIn.headers["set-cookie"];
      const session = {
        origin: "http://127.0.0.1",
        cookie: cookieHeaderFromSetCookie(Array.isArray(setCookie) ? setCookie : [setCookie]),
      };
      return {
        id: created.json().data.principalId,
        request: (method, url) =>
          app.inject({
            method,
            url,
            headers: { host: "127.0.0.1", ...authenticatedHeaders(session) },
          }),
      };
    }
    const deployer = await person("deployer");
    const sharee = await person("sharee");
    const bind = async (subjectId, roleId, resourceKind, resourceId) => {
      const binding = await inject("POST", `${policyPath}/access-bindings`, {
        subjectKind: "identity",
        subjectId,
        roleId,
        resourceKind,
        resourceId,
      });
      assert.equal(binding.statusCode, 201, binding.body);
    };
    // The deployer may deploy this Agent: deploy needs Agent deploy, Configuration read and
    // operate on the Harness Secret. Nothing grants revision read.
    const member = await inject("POST", `${policyPath}/roles`, {
      permissions: [
        { action: "read", resourceKind: "agent" },
        { action: "deploy", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "operate", resourceKind: "secret" },
      ],
    });
    assert.equal(member.statusCode, 201, member.body);
    await bind(deployer.id, member.json().data.id, "agent", agent.id);
    await bind(deployer.id, member.json().data.id, "configuration", agent.configurationId);
    await bind(deployer.id, member.json().data.id, "secret", secretRef.id);
    // The sharee reads the Agent, as the Console share panel grants, and may not deploy.
    const reader = await inject("POST", `${policyPath}/roles`, {
      permissions: [{ action: "read", resourceKind: "agent" }],
    });
    assert.equal(reader.statusCode, 201, reader.body);
    await bind(sharee.id, reader.json().data.id, "agent", agent.id);

    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const deployerRole = `role_${namespace.id}_deployed_revision_read`;
    async function deployAs(principal) {
      const admitted = await principal.request("POST", `${agentPath}/deploy`);
      assert.equal(admitted.statusCode, 202, admitted.body);
      const revision = admitted.json().data;
      const event = await pool.query(
        `SELECT details FROM occ.audit_events
         WHERE action = 'openclaw.agents.deploy' AND resource_id = $1`,
        [revision.id],
      );
      assert.equal(event.rowCount, 1);
      return { revision, details: event.rows[0].details };
    }
    const deployerBinding = (revisionId) => ({
      id: `binding_${revisionId}_deployer_read`,
      subjectKind: "identity",
      subjectId: deployer.id,
      roleId: deployerRole,
      resourceKind: "agent_revision",
      resourceId: revisionId,
    });

    // The member's deploy writes her exact grant in the admission transaction and its audit
    // event names it. Before this grant she could not read the version she started (D94).
    const second = await deployAs(deployer);
    // Deployment-status polls check the same permission; this app queues no worker work.
    const read = await deployer.request("GET", `${agentPath}/revisions/${second.revision.id}`);
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(second.details.grantedAccessBindings, [deployerBinding(second.revision.id)]);
    // The grant is exact: not the administrator's earlier revision, and nothing for a sharee.
    const listed = await deployer.request("GET", `${agentPath}/revisions`);
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(
      listed.json().data.map((revision) => revision.id),
      [second.revision.id],
    );
    assert.equal(
      (await deployer.request("GET", `${agentPath}/revisions/${first.id}`)).statusCode,
      403,
    );
    assert.equal(
      (await sharee.request("GET", `${agentPath}/revisions/${second.revision.id}`)).statusCode,
      403,
    );

    // A deployer that already reads every revision gets no grant and no audit entry.
    const byAdministrator = await deployAs({ request: (method, url) => inject(method, url) });
    assert.equal(byAdministrator.details.grantedAccessBindings, undefined);

    // A later deploy by the member reuses the Namespace's one deployed-revision Role.
    const fourth = await deployAs(deployer);
    assert.deepEqual(fourth.details.grantedAccessBindings, [deployerBinding(fourth.revision.id)]);
    const roles = await inject("GET", `${policyPath}/roles`);
    assert.deepEqual(
      roles
        .json()
        .data.filter((role) => role.id === deployerRole)
        .map((role) => role.permissions),
      [[{ action: "read", resourceKind: "agent_revision" }]],
    );
    const bindings = await inject("GET", `${policyPath}/access-bindings`);
    const granted = bindings
      .json()
      .data.filter((binding) => binding.roleId === deployerRole)
      .map(({ namespaceId, ...binding }) => binding)
      .sort(byId);
    assert.deepEqual(
      granted,
      [deployerBinding(second.revision.id), deployerBinding(fourth.revision.id)].sort(byId),
    );

    // The accepted delete event lists the grants among the bindings its completion removes
    // (the finalizer predicate itself is covered by postgres-agent-deletion-audit).
    const deleting = await inject("DELETE", agentPath);
    assert.equal(deleting.statusCode, 202, deleting.body);
    const deleted = await pool.query(
      `SELECT details FROM occ.audit_events
       WHERE action = 'openclaw.agents.delete' AND resource_id = $1`,
      [agent.id],
    );
    assert.equal(deleted.rowCount, 1);
    const removed = deleted.rows[0].details.accessBindingsRemovedOnCompletion.filter(
      (binding) => binding.roleId === deployerRole,
    );
    assert.deepEqual([...removed].sort(byId), granted);
  },
);
