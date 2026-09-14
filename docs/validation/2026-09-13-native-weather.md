# Native weather validation — 2026-09-13

Implemented a bounded native macOS weather slice on `codex/native-weather`. Dashboard schema v1 is unchanged; existing browser exports still round-trip without weather settings.

Automated fixtures cover: no transport call before opt-in; coordinate validation; exact HTTPS endpoint and minimal query; 10-second request timeout; decoding current conditions, Unix observation time, and units; client-side status, final URL, and 64 KB body enforcement even with injected transports; huge values, stale/future observations, unsupported or malformed payload rejection; private `0600` atomic persistence; bounded cache validation and 30-minute freshness; failed-save rollback; corrupt-cache preservation and write lock; disable clearing place and snapshot; late-result suppression after disable; provider failure retaining cached data with its age. Temporary fixture directories are removed by test teardown. All provider tests inject synthetic JSON and transport/time/cache fixtures and use no live city or account.

Automated validation:

- `xcrun swift build` — passed on the local Command Line Tools Swift toolchain.
- All 20 Swift tests passed on the MacBook with macOS 15.1 and full Xcode Swift 6.0.3: eleven weather cases plus nine existing dashboard regressions.
- The Node 24/Bun 1.4.2 full workspace check passed 162 tests with one platform skip, plus lint, format, contracts, types and browser build.

Physical mini acceptance used the production views, store and real Open-Meteo HTTPS transport in a temporary app with a separate bundle ID and isolated state directory. The native UI began off, accepted the public city-center coordinates for San Francisco after explicit opt-in, fetched real current weather, displayed attribution and observation time, and refreshed successfully. Disabling returned to the unconfigured state; filesystem inspection confirmed a `0600` disabled file with no place or snapshot. No household location, existing configuration or service was read or changed.

This live check exposed a clear-night sun icon. The adapter now requests and validates `is_day`, stores it, and selects moon or sun symbols. Synthetic tests cover clear and partly cloudy nights and reject invalid day/night flags. Weather code 1 and 2 also have distinct labels. The final native build fetched the public-city forecast with a moon symbol and retained its place, observation time and forecast after quit/relaunch. The validation app was then closed. The final production bundle built and passed signature verification on the mini.

Provider/cache failures, stale values and cancellation use injected fixtures, not a disruption of the real network. Full VoiceOver, all widget sizes, non-US units, automatic place search, iPhone weather and sustained provider availability remain unvalidated or outside this slice. The app is a development build with an ad hoc signature; no signed release or service deployment occurred.
