# Browser native host management

Ellie can prepare the fixed Arc native-messaging manifest for an already captured immutable service
release. This command installs a manifest file only. It does not load an extension, open or change a
browser profile, start a service, request Accessibility access, or establish receipt-v2 publisher
trust.

Review an installation without writing anything:

```sh
ellie browser-webmcp host preflight --browser arc --release ABSOLUTE_CAPTURED_RELEASE
```

Install or remove the manifest explicitly:

```sh
ellie browser-webmcp host install --browser arc --release ABSOLUTE_CAPTURED_RELEASE
ellie browser-webmcp host uninstall --browser arc --release ABSOLUTE_CAPTURED_RELEASE
```

The release must be an owner-provided immutable payload with the supported release metadata layout
and fixed native-host launcher. These checks do not authenticate who produced the release.
The installer records the exact release, launcher digest, and manifest digest in private Ellie state.
It refuses an existing manifest without that matching ownership record and preserves changed,
malformed, linked, or unsafe evidence. Known phase subsets without a lock can be completed by the
matching command. An interrupted process can retain its exclusive lock; preflight reports recovery
required and no command reclaims that lock from a PID assertion. Inspect retained evidence before
manual recovery. A successful preflight or install does not prove publisher admission, that the
extension is loaded, that Arc has opened the host, or that macOS Accessibility consent is available.
