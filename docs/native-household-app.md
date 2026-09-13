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

The iPhone currently supports local dashboard editing, notes, clocks, explicit coordinator enrollment and granted app opening. Mac weather, agenda, chores and playlist providers are not yet rendered on iPhone. Imported widget settings survive edits and export. Physical installation still requires signing; simulator results do not validate a phone camera, local-network consent or a phone-to-Mac action.

Dashboards and chores still save independently on each device. The [household-state backend](household-state.md) provides explicit private/shared grants and durable conditional saves; native profile, save and conflict controls are the next client slice. Calendar is an offline snapshot, not a connected Google account. Voice recognition never supplies authorization for a privileged action.

See the [integration validation record](validation/2026-09-13-native-household-integration.md) for exact test scope.
