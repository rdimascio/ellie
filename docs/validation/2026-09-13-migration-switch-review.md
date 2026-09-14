# Stopped migration switch review

The first migration-switch draft, based on PR67
`cec3248fa297f1b2ec97a5d5555788584b20ead2`, passed its existing local gate but did
not pass coordinating and independent review. It remains unpublished while these findings
are corrected.

Root independently reproduced two crash failures using a captured source copy and owned
synthetic installer fixtures. The reviewed selection source had SHA-256
`7661a3ee0dd9019c896cbd1a71d28c90fb287c0721547aea5105888ae43cf96f`, and its test file
had SHA-256 `12af1526bcda3ea5ed66749608adb159a3ad97cb196b682bb54fb836dc7735e8`.
Only test-only crash hooks and matching fixture assertions were added to that copy.

- A crash immediately after a staged packaged app was renamed into place, before sealing
  its root from `0700` to `0555`, left explicit recovery returning failure. The old draft
  accepted only the final root mode when removing the replacement before restoring legacy
  files. The isolated regression failed at this exact boundary in 6.177 seconds.
- A crash during committed cleanup, after removing the legacy coordinator app backup but
  before unlinking its plist backup, left the next recovery permanently refusing the unequal
  backup pair. The fixture verified the app backup was absent and the plist backup remained;
  the subsequent recovery assertion failed in 6.900 seconds.
- A staged app containing only the first eight correct bytes of its expected `Info.plist`
  also prevented recovery, even though no original service file had moved. That synthetic
  interrupted-copy state failed in 6.712 seconds. Recovery must distinguish a verified
  prefix of an expected file from unknown content; a subset of complete files alone is
  insufficient.

Two initial attempts to run the captured test failed dependency resolution before tests
started. After installing its frozen dependencies offline in the owned copy, the actual
crash regressions above ran. No household installation, service, Keychain or permission
was involved.

The source review also requires checking pending preparation/selection transactions before
switching; rechecking the switch journal under lifecycle locks; read-only canonical path
revalidation before receipt commit; recovery of every legitimate staged and published
state; and the approved `adopt-migration` contract for all roles actually installed on a
Mac, including coordinator-only or node-only installations. Unknown or competing evidence
must remain preserved. The revised implementation and tests need a fresh final review;
the original passing gate does not establish these missing behaviors.

The first revision corrected complete-but-unsealed app recovery and retained committed
backups rather than deleting them. Further review still found partially copied or partially
deleted trees could block precommit recovery. The approved follow-up retains abandoned
artifacts under deterministic transaction evidence names, validates bounded source-file
prefixes before accepting interrupted staging, uses atomic publication of the active
journal, and records whether recovery committed or restored legacy files. It also requires
exact correlation between journal roles and the single target release in the new receipt.
Those follow-up changes are not yet accepted by this record.

Final review of that follow-up found additional recovery boundaries requiring corrections:

- A normal hardened `umask 077` can leave a correctly copied file prefix with mode
  `0400` or `0500`, before the copy finishes and applies its final mode. Accepting only
  `0444` or `0555` misses this legitimate interrupted state. Moving the chmod earlier
  alone still leaves the open-to-chmod boundary.
- An interrupted write of the completed transaction record can leave its deterministic
  temporary file. Recovery must preserve or safely resume a verified prefix instead of
  failing forever on exclusive creation of the same name.
- After a legacy app or plist has been restored, the backup is absent. A repeated
  recovery must still validate previously retained replacement evidence; that validation
  cannot depend on the backup remaining present.
- Partial-file validation must bind opened descriptors to inspected identities and check
  the destination length, so a reopened or changed file is not accepted using stale
  metadata.

These are source-review findings, not new hardware failures. The author is adding focused
regressions before the next final review. No migration-switch implementation PR has been
published and no installed service has been changed.
