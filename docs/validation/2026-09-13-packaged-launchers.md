# Packaged service launcher validation — 2026-09-13

Synthetic tests build and ad-hoc sign the shipping Swift source twice, using the stable Ellie
Coordinator and Ellie Node bundle identifiers and existing icon. An owned release fixture outside
the checkout contains a finite fake Node executable, CLI entrypoint, helper, and exact manifest. The
fixture is converted from builder modes to the documented read-only installed projection before
either launcher is executed.

Both shipping launcher binaries validate the complete declared payload, reject links and writable
content, and verify every size and SHA-256. The focused launcher case covers normal execution, an
undeclared empty directory, an undeclared file, changed declared file bytes, a declared path deeper
than 16 directories, more than 4,096 declared directory and file entries, an inverted required
executable mode, and source revisions with LF, CR, CRLF, or a non-hex suffix. Rejections exit with
configuration status 78 before execution. The normal case observes the exact packaged CLI path,
fixed compiled role, verified packaged helper, minimal executable path, and removal of an injected
`NODE_OPTIONS` value. Separate model tests cover the shared helper resolver's explicit absolute
packaged path, invalid relative path rejection, and existing local-development fallback.

A separate acceptance copied the complete prepared payload outside the checkout, replaced only its
Node executable with a finite script, updated that one manifest record, and projected the entire
tree read-only. Each shipping launcher validated the real payload topology and hashes, then invoked
the script with the packaged CLI and helper paths and its fixed role. The injected `NODE_OPTIONS`
value was absent. The actual CLI was not executed in this acceptance.

These tests use no live service, launchd domain, Keychain item, configuration, helper action, TCC
permission, or network. They do not install the apps, prove an Intel binary, preserve an existing
Developer ID designated requirement, establish Accessibility or Keychain consent continuity, or
exercise real coordinator/node credentials. The ad-hoc identities establish bundle construction
and validation behavior only.
