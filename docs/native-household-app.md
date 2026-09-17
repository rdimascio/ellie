# Native household app

Ellie's Mac and iPhone interfaces are SwiftUI applications. The Mac app uses a system sidebar, toolbar, menus, sheets, file panels and a separate Devices window. The iPhone app uses native navigation, forms, camera enrollment and Keychain storage. The browser prototype remains a compatibility and protocol reference.

This integration preserves the native Mac pairing, iPhone enrollment and app-control, and imported-agenda histories in one build. The Mac owns one dashboard, chores, weather and agenda store per application; every relevant widget observes its store. A selected playlist remains configured per widget. Editing an imported playlist's title or size on iPhone preserves its playlist ID even though playback is currently a Mac feature.

## Run an isolated Mac preview

Use Node 24 and the repository's Bun lockfile. These commands build the app without installing or restarting a household service:

```sh
bun install --frozen-lockfile
bun run desktop:build
preview_dir=$(mktemp -d /tmp/ellie-native-preview.XXXXXX)
open dist/desktop/Ellie.app --args --state-path "$preview_dir/dashboardsv1.json"
```

Use a newly launched app process for the custom state path; an already-running instance retains the stores it opened at launch. Chores, weather and agenda use sibling files in that same preview directory. The Devices window loads the existing coordinator or node identity only after an explicit Connect action. A preview does not pair, grant access, play a video or send a desktop command on launch.

Try creating and renaming a dashboard, adding widgets, completing a dated chore and reopening the app with the same state path. Notes, layout and chore completion persist. A Calendar widget can display an explicitly imported [agenda snapshot](native-calendar.md); [weather](native-weather.md) requires an explicitly configured place, and a [playlist](native-playlists.md) starts only when requested.

## iPhone development target

Open `apps/ios/EllieIOS.xcodeproj` in Xcode. `bun run ios:build` builds for the simulator; `bun run ios:test` runs the isolated navigation and persistence workflow. `bun run test:ios-ats` separately tests the app's actual pinned HTTPS transport and isolated Keychain lifecycle against a synthetic local listener. These commands require full Xcode and an available simulator runtime.

The iPhone supports local dashboard editing and chores, notes, clocks, explicit coordinator enrollment and granted app opening. Local chores remain in this iPhone's private file. Imported widget settings survive edits and export. Physical installation still requires signing; simulator results do not validate a phone camera, local-network consent or a phone-to-Mac action.

The [household-state backend](household-state.md) provides explicit private/shared grants and durable conditional saves. Paired iPhones can open **Coordinator → Household Chores** for a separate shared copy; local chores are never uploaded or replaced automatically. Calendar is an offline snapshot, not a connected Google account. Voice recognition never supplies authorization for a privileged action.

## Shared chore setup and manual QA

On the coordinator Mac, identify the currently enrolled phone with `bun run ellie native clients`. The owner must explicitly grant that client shared chore access; pairing and app-opening grants do not supply it. Use `bun run ellie household grant CLIENT_ID shared chores read` for read-only access, or `bun run ellie household grant CLIENT_ID shared chores write` for editing. The latter replaces that same grant and includes read access. `bun run ellie household grants` confirms the current grant after an uncertain management response; `bun run ellie household revoke CLIENT_ID shared chores` removes it. These commands require the existing controller authority and do not run from the phone.

In the iPhone's Household Chores view, tap **Check Household Chore Access**, then **Read Current Household Chores**. A read grant shows the shared copy but cannot prepare or save a change. With a write grant, add, edit, complete, undo or delete a chore; review the proposed change, including details, completion day and removed rows, before **Save Prepared Change Once**. The full replacement copy is available in the review disclosure. A successful save advances the server revision. The local chores card and `choresv1.json` remain unchanged; this first workflow has no local-to-shared bulk migration.

For conflict QA, let two authorized phones read the same revision. Save on one, then attempt the other's prepared change: the latter must retain its draft at a 412 conflict. **Check Result Without Resending** reads the current copy; the user must discard the pending change, read again and prepare a new edit explicitly. If a save is cancelled, disconnected or its response is lost, relaunching must still show the pending unknown change and offer only that read-only result check or explicit discard. Matching current content does not prove which client saved it. Revoking the grant clears connected data without changing local chores; re-pairing creates a new client ID and grants nothing automatically.

See the [integration validation record](validation/2026-09-13-native-household-integration.md) for exact test scope.
