# Ellie app icon

`Ellie.png` is the source image for both macOS service app icons. The installer generates the standard 16–1024 pixel ICNS representations with macOS `sips` and `iconutil`; no image service or network access is needed to build or install Ellie.

Created with the built-in imagegen tool for this repository. Final generation prompt:

> Use case: logo-brand. Asset type: production macOS application icon for Ellie, a warm, caring, capable local household assistant. Create one polished distinctive app icon, 1024x1024 square canvas. A friendly minimal lowercase e character subtly suggesting a welcoming smile, sculpted soft ceramic with a warm gentle palette and strong contrast, centered on a rounded-square tile. Restrained soft material depth, elegant silhouette readable at 16px in macOS System Settings. The icon should feel calm, personable and useful in a home. Front-on view, large centered mark, generous uncluttered interior space. Actual transparent background outside the rounded-square tile, preserving alpha; no surrounding mockup, no macOS window, no extra text, no wordmark, no robot, no network diagrams, no generic AI sparkle, no watermark.

The generated master is 1254×1254 with alpha. The app installer resamples it to the required icon sizes.
