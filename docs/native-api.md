# Native enrollment contract

`contracts/native-openapi.v1.json` describes the three implemented native session routes on the optional client HTTPS listener. The separate `contracts/openapi.v1.json` describes the coordinator, including controller-only native invitation/list/revoke management. A native session is not a coordinator identity and cannot submit desktop commands through either contract in this slice.

The listener route registry and lifetime/body limits live in `packages/protocol/src/native-session-contract.ts`; the runtime and generators consume them. Native schemas are shared between both OpenAPI documents. The semantic label, canonical origin, unique-target and QR validators remain authoritative where JSON Schema alone cannot express a cross-field or byte-encoding rule. The listener wire behavior is unchanged by publishing this contract.

## Cross-language fixtures

`contracts/native-pairing-fixtures.v1.json` contains synthetic valid and invalid QR envelopes, their decoded payloads, a fixed reference time and actual `{client}` response wrappers. It includes Unicode, quotes, backslashes and canonical IPv6 origins so native clients do not accidentally substitute a different serializer or URL normalizer. It is generated using the same TypeScript QR encoder that the CLI uses. Tests require all valid cases to round-trip and all invalid cases to be rejected. Fixture invitations, pins and tokens are public synthetic values, never household credentials.

The complete `ellie-native:v1:` envelope is at most 2,300 ASCII bytes. Its JSON uses compact ECMAScript serialization in this order: `version`, `origin`, `certificateSha256`, `invitation`, `expiresAt`, `label`, `grants`; grant keys are `target`, then `capabilities`. UTF-8 bytes are encoded as unpadded base64url. Dates are integer Unix milliseconds. Parse first, validate every field, re-encode canonically and require exact bytes. A scanner must additionally check expiry against the current clock before confirmation; parser fixtures intentionally use a fixed reference time.

## Mutation uncertainty

Before its one pairing POST, a client generates a random candidate credential and safely retains the origin, pin and expected grant metadata. The invitation remains transient. If the POST response is lost, explicit recovery uses only `GET /native/v1/session` with that candidate. It does not resubmit the invitation. A successful response contains public client metadata and no token; clients must validate the returned role, scope and expiry before marking enrollment confirmed.

Logout success confirms durable server revocation. An interrupted logout remains uncertain. Deleting a local Keychain item does not itself revoke server authority. Expiry, explicit controller revocation and read-only session checks remain available. The native Swift client and its Keychain/camera acceptance are separate work.

## Validation

Run `bun run contracts:generate` after a reviewed contract change, and `bun run check` before publishing. CI runs the same drift check. The new tests verify the dedicated security scheme, unauthenticated pairing operation, exact runtime routes, body/header rules, response wrappers, resolved schema references and canonical fixture behavior. Existing synthetic loopback HTTPS and private-file session tests continue to cover runtime behavior; this contract work does not contact an installed coordinator, camera, phone or Keychain.
