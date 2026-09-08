# Host Grant And Host Resume Authority Proof

Last updated: 2026-09-08
Status: Gate `G5-02` authority slice implemented and locally proven; reviewed merge and coordinated production cutover pending

## Outcome

The working branch closes `AJ-SEC-003` without adding a login, permission
prompt, or alternate room-joining flow. Arcade visitors receive an anonymous,
signed launch session from the trusted platform. The platform can exchange that
session for one short-lived host grant, and the realtime server can consume the
grant exactly once to establish the intended host authority.

The ordinary interaction remains:

1. open Arcade
2. select a game
3. receive a room code
4. join from controllers as before

The security machinery stays below that product surface.

## Authority Chain

One explicit chain now owns Arcade system-host bootstrap:

1. platform middleware issues the `__Host-airjam-launch-session` secure,
   host-only cookie with a non-forgeable anonymous abuse-session identity
2. the same-origin host-grant endpoint requires the exact platform origin and
   a valid, unexpired launch session
3. the endpoint resolves one active app credential and its canonical game and
   creator identity from PostgreSQL
4. it issues an `airjam.host_grant.v3` grant containing a UUID `jti`, fixed
   realtime audience, app/game/creator identity, bounded lifetime, allowed
   origin, session kind, launch intent, and abuse-session identity
5. the realtime auth service validates every claim and atomically consumes the
   `jti` in PostgreSQL before granting socket bootstrap authority
6. host lifecycle handlers require the grant's system session kind and
   `system_register` intent before accepting Arcade system registration

Migration `0040_host_grant_consumption.sql` adds the durable single-use
authority and its expiry index. Consumption identity, session kind, intent,
chronology, and non-empty claims are constrained by PostgreSQL rather than
trusted to process memory.

The database lookup and insert occur in one statement. Two realtime instances
or concurrent sockets racing the same grant therefore cannot both accept it.
Invalid origin, audience, scope, intent, session kind, app ownership, expiry,
or replay fails closed without consuming a grant that was otherwise valid for
a different intended action.

## Active-Room Ownership

A successful room creation returns a server-issued host resume capability. The
SDK persists that opaque capability with the room identity and supplies it for
reconnect. A room code alone is no longer master authority.

The realtime server rejects:

1. reconnect without the exact room capability
2. system registration over a room owned by another active host
3. a second `registerSystem` call that attempts to bind one socket to a
   different room
4. system registration from game-scoped bootstrap authority

A room reset creates a new room and rotates the resume capability. The old
room capability cannot claim the new room. Legacy room-only browser storage is
discarded rather than silently treated as authority.

## Removed Hosted Bypass

`AIR_JAM_MASTER_KEY` is no longer an accepted hosted authentication backend.
Production and Railway preview environments in required-auth mode need the
canonical PostgreSQL app/grant authority. The master key remains available only
for explicit development and test environments where it is useful as a local
tool.

This is a deliberate zero-compatibility cleanup:

1. host-grant versions before v3 do not satisfy the protocol schema
2. room-only reconnect state is not upgraded into authority
3. hosted master-key authentication has no fallback path

## Local Validation

The retained focused proof covers:

1. v3 grant creation, verification, mutation rejection, expiry, excessive
   lifetime, and future-issued rejection
2. launch-session issuance plus tampered, wrongly signed, and expired failure
   paths
3. exact same-origin, valid launch-session, and active app-credential
   requirements at the platform endpoint
4. canonical app/game/creator binding
5. one-time and exactly-one-winner concurrent PostgreSQL consumption
6. missing and forged origin, replay, mismatched intent, stale ownership, and
   bounded expired-consumption cleanup
7. legitimate first launch while rejecting raw replay and active-room hijack
8. rejection of game-scoped system registration
9. rejection of repeated system registration without orphaning the original
   room or its indexes
10. host reconnect capability issuance, persistence, required ownership, and
    rotation on room reset
11. hosted master-key rejection and explicit local-development behavior
12. a fresh migration catalog through `0040` classified `ready` by the
    canonical database-migration inspector

The focused server proof currently passes `54/54` tests against local
PostgreSQL 14. The phased `0037` to `0038` to `0039` ownership/admission upgrade
test and a fresh catalog application through `0040` also pass. These are local
implementation facts, not production claims.

The post-edit complete local batch also passed on 2026-09-08 with the protected
PostgreSQL lane enabled: canonical guards, typechecks, lint, repo contracts,
194 server tests, 281 SDK tests, and 453 platform tests all passed. Canonicalizer
returned `ready` after shared operational-authority and local-master-key rules
were reduced to one owner. Protected review and production proof remain
separate gates.

## Coordinated Rollout Boundary

Grant v3 and capability-based reconnect intentionally replace the old contract
rather than carrying dual verification paths. Production rollout therefore
requires one short, controlled admission cutover:

1. apply and verify migration `0040` while the current application remains
   compatible with the additive table
2. pause new room admission while allowing existing rooms to continue
3. deploy the platform grant issuer, SDK-facing Arcade build, and realtime
   verifier/lifecycle implementation from their reviewed commits
4. verify platform readiness, realtime readiness, grant issuance, one
   legitimate system-host launch, replay rejection, reconnect, logs, and exact
   deployed revisions
5. restore normal room admission only after those checks pass
6. roll back the exact deployments and keep admission paused if any authority
   boundary fails

This document does not claim that `AJ-SEC-003` is closed in production. Gate
`G5-02` retains ownership until protected review, guarded migration, coordinated
deployment, hostile-path smoke proof, and retained production evidence all
pass.
