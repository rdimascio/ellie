# Native installer inspection on the MacBook

The unchanged development service payload from [PR60](https://github.com/rdimascio/ellie/pull/60)
passed read-only inspection on a physical arm64 MacBook running macOS 15.1. The artifact was built
on the separate macOS 26.6.2 mini; no compiler or developer Node installation was used on the
MacBook for this check.

- Source: `baccc883c4701eecacd2d1ca13d35327aa997292`.
- Archive: `EllieServices-0.1.0-dev-baccc883-macos-arm64.zip`.
- Local and remote SHA-256: `fa2399571e5cc597ea04be717d265d226b5315bb29432b1f9f61cd633bfe3afb`.
- Installer strict code-signature verification passed: identifier `org.ellie.installer`, ad-hoc signature.
- Shipping `payload/bin/ellie-service-installer inspect RELEASE_ROOT` exited zero and returned
  `0.1.0-baccc883c4701eecacd2d1ca13d35327aa997292-arm64`.

The archive was copied to a new owned temporary directory, checked, and extracted there. The
release input used its canonical `/private/tmp/...` path: descriptor-relative inspection rejects
symlinked parent components, including macOS's `/tmp` alias. The owned directory was removed after
the process exited and its absence was verified.

This ran the actual shipped native inspector without source changes or runtime substitutions. It
establishes inspector compatibility with macOS 15.1. It did not invoke `stage`, select a release,
run the CLI or native helper, change launchd or Keychain, exercise GUI control, or contact household
services. It does not establish service installation, upgrades, login, sleep/wake or the newer
combined PR59 artifact's physical acceptance. Staging fault and mutation tests remain separate
synthetic checks under owned test roots.
