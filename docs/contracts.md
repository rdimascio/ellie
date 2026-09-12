# Operation contracts

Ellie protocol version 1 has four desktop operations. `packages/protocol/src/operations.ts` is their canonical executable registry. It declares each stable operation ID, required capability, bounded input and output, and the fields checked against each node's local app and site allowlists. The protocol's `Action`, `Capability`, `Layout`, and `Monitor` TypeScript types and runtime action validator are derived from that registry.

The registry uses the deliberately small `ellie-operation-schema-1` dialect: objects with required properties, strings with length/pattern/enum constraints, constants, booleans, and the Ellie-specific `ellie-https-url` format. The runtime format accepts only absolute HTTPS URLs without embedded credentials and normalizes them using `URL`. Version 1 accepts and discards undeclared fields when it creates canonical normalized actions, jobs, and results, matching the original wire behavior; every HTTP body remains subject to the 32 KiB transport limit. This validator does not claim support for arbitrary JSON Schema.

Regenerate the committed artifacts after changing the registry:

```sh
bun run contracts:generate
```

Check for drift without writing files:

```sh
bun run contracts:check
```

`contracts/protocol.v1.schema.json` is the generated JSON Schema for desktop jobs and shared result/error shapes. `contracts/openapi.v1.json` describes only the HTTPS routes implemented by the current coordinator. OpenAPI captures syntactic request constraints. Bearer identity roles, node ownership, capability grants, online/busy state, worker admission, and the coordinator and node app/site allowlists remain semantic runtime checks described on each operation.
