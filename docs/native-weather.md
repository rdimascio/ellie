# Native weather widget

Ellie’s macOS weather widget is local-first and off by default. The setup sheet asks the user to name a place and enter its latitude and longitude. Ellie does not request Core Location access, search contacts or accounts, or perform a network request before the user turns on Open-Meteo forecasts and saves a valid place.

Weather settings and the last successful forecast live in `~/Library/Application Support/Ellie/weatherv1.json`, separate from dashboard schema v1 and dashboard imports/exports. The file is replaced atomically with mode `0600`; Ellie creates its own application-support directory with mode `0700`. Reads are capped at 32 KB and reject links, non-files, broad permissions, invalid state combinations, unsafe values, and future timestamps. An unreadable file is preserved and blocks settings writes instead of being silently replaced. Turning weather off cancels the active refresh, immediately clears in-memory data, and replaces the weather file with an empty, disabled state. If disk clearing fails, Ellie states that the old place may remain on disk.

The adapter sends one HTTPS GET to `api.open-meteo.com` for explicitly configured coordinates. It requests only current temperature, apparent temperature, WMO weather code, and 10 m wind speed for one forecast day, using Unix observation time in GMT. The ephemeral URL session stores no cookies or URL cache, has 10-second request and 12-second resource deadlines, rejects all redirects, checks the final URL, status, body size, units, observation age, supported WMO codes, and plausible finite values, and stops streaming after 64 KB. Swift task cancellation propagates into the URL session; disabling also cancels the store’s current refresh. Successful responses are cached for 30 minutes. On later provider failures, the widget keeps its last forecast and shows its existing age.

The widget links “Weather data by Open-Meteo.com” beside forecast data. The provider’s official documentation says the forecast endpoint accepts WGS84 latitude and longitude and a `current` variable list. Its current licence page requires CC BY 4.0 attribution and a link beside displayed Open-Meteo data. The free endpoint terms limit use to non-commercial applications and list rate limits; a commercial Ellie distribution must use an appropriate Open-Meteo commercial plan or a compatible self-hosted endpoint before release.

Sources checked 2026-09-13:

- [Forecast API documentation](https://open-meteo.com/en/docs)
- [Data licence and display attribution](https://open-meteo.com/en/license)
- [Terms, privacy, and free-endpoint limits](https://open-meteo.com/en/terms)
- [Commercial API plans](https://open-meteo.com/en/pricing)
