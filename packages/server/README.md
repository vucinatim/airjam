# Air Jam Realtime Server

`@air-jam/server` owns realtime rooms, controller sessions, gameplay signal
routing, and hosted admission for Air Jam games. PostgreSQL owns hosted
instance, room, and controller leases; gameplay state remains in the realtime
process.

## Railway Preview Startup

The platform is the only preview schema-migration owner. Railway must therefore
activate services in this order for every fresh PR environment:

1. `air-jam-platform` migrates the ephemeral PostgreSQL database and becomes
   healthy
2. `air-jam-server` starts and registers its realtime admission lease
3. `air-jam-platform-worker` starts after the platform, realtime server, and
   browser worker are ready

The base Railway environment expresses those edges with service reference
variables. Do not replace them with rendered URLs: Railway uses the references
to derive PR-environment startup ordering.

See the
[Railway deployment guide](../../docs/guides/railway-deployment-guide.md) for
the complete preview and production contract.
