# Browser-local dashboard editor

The command-center preview includes a **Dashboards** view for creating room boards and composing widgets. Dashboard names, order, widget titles, sizes, and note text persist in the current browser's local storage. People can create, rename, and delete boards; add, configure, reorder, and remove widgets; reset to the starter board; or export and import the versioned JSON format.

## Current behavior

The clock uses the viewing device's local time and updates once a second. Notes are editable text. Weather, calendar, chores, and playlist widgets are clearly marked connection placeholders. They do not contact a provider, display synthetic live data, accept credentials, or support embedded HTML, scripts, and iframes.

The editor validates stored and imported data against the strict dashboard schema. Invalid stored data is replaced with the starter board and announced in the interface. An invalid import leaves the current dashboards unchanged. A downloaded export contains dashboard configuration and note text, so review it before sharing.

This slice is browser-local. It does not sync between devices, connect to household services, authenticate viewers, or publish a board to a shared display. Clearing site data removes saved boards unless they were exported first.

## Accessibility and layout

Every editor operation is a native button, input, select, or text area with an accessible name and visible keyboard focus. Reordering has explicit “earlier” and “later” controls rather than requiring drag gestures. Status changes are announced through a polite live region. The layout collapses from a rail and two-column widget canvas to touch-sized horizontal board navigation and a single widget column on narrow screens.

Browser coverage verifies persistence across reload, widget configuration/reordering/removal, strict rejection of invalid stored and imported data, no outside requests, and horizontal fit at phone, laptop, and TV viewport sizes. These are emulated browser checks rather than physical device acceptance.
