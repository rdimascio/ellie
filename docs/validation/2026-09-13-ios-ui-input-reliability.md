# iOS UI test input reliability

[PR66](https://github.com/rdimascio/ellie/pull/66), commit
`61ac1035f50362912ce0857a129cd0d8fc906000`, changes each field entry from one XCTest
input operation and value lookup per character to one `typeText` operation followed by
the existing exact complete-value assertion. Both workflows, their content, selectors,
persistence and deletion checks, and the runner's 600-second deadline remain unchanged.

The change follows a [failed PR59 native job](https://github.com/rdimascio/ellie/actions/runs/34795594905/job/103827947322)
associated with head `9f54b704827501fa13b599d521abcca7b42f0425`. Swift tests passed
158/158, the simulator booted, and the Coordinator navigation UI test passed. During the
dashboard workflow, XCTest stalled while reacquiring the note editor for the third
per-character input operation. The runner reached its `xcode-test` deadline and retained
the result bundle and diagnostic. ATS tests were not reached. The diagnostic recorded
`outcome=timeout`, with simulator shutdown failing and deletion completing.

The other native job associated with this head passed both UI tests and ATS. There is
no established generic cause for the XCTest stall, and no shared-host contention or
product assertion failure is inferred. The change reduces repeated automation calls;
it does not claim to eliminate every XCTest timeout.

The exact changed source passed the complete two-test workflow on an owned iOS simulator
on the physical MacBook. XCTest reported two tests and zero failures in 42.051 seconds;
the runner took 92.094 seconds. The dashboard workflow took 31.876 seconds. Final
diagnostics reported `stage=complete`, `outcome=passed`, and completed simulator shutdown
and deletion. Owned remote source and scratch were removed afterward. The coordinator
reviewed the one-file diff, exact source hash and retained sanitized success log before
publication. No redundant full Node gate was required for this Swift UI-test-only change.

This is simulator acceptance, not physical iPhone or household-service acceptance. It
used no live Ellie service, enrolled identity, Keychain item, microphone or camera.

All seven current PR66 CI checks passed: two TypeScript, two native, two command-center
jobs and the security check. The combined candidate still needs its own CI evidence.
