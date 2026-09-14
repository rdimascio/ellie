# Native command admission validation

Native app commands now enter the native authorization mutation queue after bounded node discovery
and before dispatch. A revoke, logout, expiry, or failed durable save that entered first settles before
admission. The queue is released before the remote app action starts, so a later authorization change
cannot replay or relabel an admitted side effect. Existing predispatch and unknown-outcome responses,
reservations, cancellation, and server deadlines remain unchanged.

Deterministic HTTPS regressions block the native authorization persistence callback and verify prior
revoke, logout, expiry, and failed-save ordering with zero dispatch. A separate case verifies that an
admission which wins the order dispatches exactly once and reports an unknown outcome after the
synthetic remote loses its result.

The fixture uses the real clock by default. Only the expiry case overrides it, advancing to the exact
paired client's `expiresAt`. This keeps unrelated speech expiration tied to real time.

Validation used Node.js 24.21.0 and Bun 1.4.2 on macOS with synthetic TLS identities, native sessions,
and remote actions. It did not contact a household service or perform a desktop action.
