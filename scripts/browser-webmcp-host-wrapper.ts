/** Fixed packaged native-host entrypoint. Chrome supplies frames only on stdin/stdout. */
export const browserWebMCPHostWrapper = () => `#!/bin/sh
set -eu
case \${HOME-} in /*) ;; *) exit 1 ;; esac
case \${TMPDIR-/tmp} in /*) ;; *) exit 1 ;; esac
ROOT=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")/.." && /bin/pwd -P)
exec /usr/bin/env -i HOME="$HOME" TMPDIR="\${TMPDIR-/tmp}" PATH=/usr/bin:/bin LC_ALL=C LANG=C \
  "$ROOT/bin/node" "$ROOT/lib/ellie/apps/cli/src/main.ts" browser-webmcp native-host
`;
