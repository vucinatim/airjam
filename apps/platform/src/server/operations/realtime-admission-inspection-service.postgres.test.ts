import * as schema from "@/db/schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectRealtimeAdmission } from "./realtime-admission-inspection-service";

const databaseUrl = process.env.AIR_JAM_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("realtime admission inspection PostgreSQL snapshot", () => {
  const client = postgres(databaseUrl!, { max: 4 });
  const database = drizzle(client, { schema });
  const suffix = crypto.randomUUID();
  const instancePrefix = `inspection-${suffix}`;
  const activeInstance = `${instancePrefix}-active`;
  const drainingInstance = `${instancePrefix}-draining`;
  const expiredInstance = `${instancePrefix}-expired`;

  beforeAll(async () => {
    await client`
      insert into realtime_admission_instances (
        instance_id, lease_token, started_at, heartbeat_at, expires_at,
        draining_at
      ) values
        (${activeInstance}, ${crypto.randomUUID()}, now() - interval '1 minute',
         now(), now() + interval '5 minutes', null),
        (${drainingInstance}, ${crypto.randomUUID()}, now() - interval '2 minutes',
         now(), now() + interval '5 minutes', now()),
        (${expiredInstance}, ${crypto.randomUUID()}, now() - interval '3 minutes',
         now() - interval '2 minutes', now() - interval '1 minute', null)
    `;
    await client`
      insert into realtime_room_admission_leases (
        room_id, lease_token, instance_id, max_controllers, admitted_at
      ) values
        (${`inspection-room-active-${suffix}`}, ${crypto.randomUUID()},
         ${activeInstance}, 8, now()),
        (${`inspection-room-draining-${suffix}`}, ${crypto.randomUUID()},
         ${drainingInstance}, 8, now()),
        (${`inspection-room-expired-${suffix}`}, ${crypto.randomUUID()},
         ${expiredInstance}, 8, now() - interval '2 minutes')
    `;
    await client`
      insert into realtime_controller_admission_leases (
        room_id, controller_id, lease_token, instance_id, admitted_at,
        disconnected_at, resume_expires_at
      ) values
        (${`inspection-room-active-${suffix}`}, ${`controller-active-${suffix}`},
         ${crypto.randomUUID()}, ${activeInstance}, now(), null, null),
        (${`inspection-room-active-${suffix}`}, ${`controller-resume-${suffix}`},
         ${crypto.randomUUID()}, ${activeInstance}, now(), now(),
         now() + interval '2 minutes'),
        (${`inspection-room-expired-${suffix}`}, ${`controller-expired-${suffix}`},
         ${crypto.randomUUID()}, ${expiredInstance}, now() - interval '2 minutes',
         null, null)
    `;
  });

  afterAll(async () => {
    await client`
      delete from realtime_admission_instances
      where instance_id like ${`${instancePrefix}%`}
    `;
    await client.end();
  });

  it("reports one database-time snapshot and the accepting-instance invariant", async () => {
    const before = Date.now();
    const result = await inspectRealtimeAdmission({ database });
    const after = Date.now();

    expect(new Date(result.observedAt).getTime()).toBeGreaterThanOrEqual(
      before - 1_000,
    );
    expect(new Date(result.observedAt).getTime()).toBeLessThanOrEqual(
      after + 1_000,
    );
    expect(result).toMatchObject({
      authority: "postgresql",
      acceptanceAuthority: {
        acceptingInstances: 1,
        invariant: "satisfied",
      },
      instances: { live: 2, draining: 1, expired: 1 },
      rooms: { active: 2 },
      controllers: { active: 2, disconnectedResumable: 1 },
    });
  });

  it("makes a split acceptance authority visible", async () => {
    const secondAcceptingInstance = `${instancePrefix}-second-accepting`;
    await client`
      insert into realtime_admission_instances (
        instance_id, lease_token, started_at, heartbeat_at, expires_at
      ) values (
        ${secondAcceptingInstance}, ${crypto.randomUUID()}, now(), now(),
        now() + interval '5 minutes'
      )
    `;

    const result = await inspectRealtimeAdmission({ database });
    expect(result.acceptanceAuthority).toEqual({
      acceptingInstances: 2,
      invariant: "violated",
    });
  });
});
