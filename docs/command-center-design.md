# Command center prototype

This slice explores Ellie's household interface using synthetic fixtures. It has no coordinator client, authentication, calendar integration, analytics, or ability to execute desktop commands. A persistent demo notice makes that boundary visible.

## Design plan

- Palette: Mist `#edf3f3` for the room around controls; Paper `#ffffff` for primary surfaces; Ink `#18353b` for text; Slate `#536b70` for supporting text; Ellie orange `#ef713b` for the existing brand; Pine `#176b68` for successful state. The TV uses Harbor `#173f48` to reduce glare at a distance.
- Type: Avenir Next where installed, followed by the platform sans serif. No fonts or other assets load from external services. Primary controls use 15–16 px labels with smaller supporting text; the TV uses a separate scale for distance reading.
- Layout: a household remote, with named devices beside the current Mac's controls. A schematic window preview explains placement. On the phone, devices collapse into a picker and the remote comes first. The TV dedicates most of the screen to the day's sample agenda and keeps device state secondary.
- Alignment: left-aligned labels, device names, and agenda; centered app symbols only inside controls. Large focus indicators and touch targets are part of the layout.
- Character: Ellie's existing orange icon provides warmth. The memorable element is an interactive window-placement illustration; surrounding controls are quiet and literal.

```text
Laptop                               Phone
+-------------------------------+    +-------------------+
| Ellie       Demo     View      |    | Ellie        Demo |
|-------------------------------|    | Device picker     |
| Devices | Selected Mac        |    | Selected Mac      |
|         | Window illustration |    | Window preview    |
|         | Four allowed actions|    | Action   Action   |
|         | Activity            |    | Action   Action   |
+-------------------------------+    | Activity          |
                                     +-------------------+
TV
+---------------------------------------------------+
| Ellie      Sample household             TV preview |
| Today                         | Home devices      |
| Large agenda and next item    | Clear availability |
|                               | Recent activity   |
+---------------------------------------------------+
```

## Review against the brief

The first idea was a dashboard of status cards. That made the home look like an operations console, so the design now centers the device and the action someone wants to take. The existing orange icon is retained, with a cool background instead of a cream-and-clay theme. The TV and phone share vocabulary but have different information priorities. Fictional agenda entries are explicitly samples, and a placement diagram is never presented as a live desktop image.

## Acceptance

- Phone (390 × 844), laptop (1440 × 900), and TV (1920 × 1080) layouts remain usable; a narrow 320 px viewport does not overflow horizontally.
- Ready, loading, offline, empty, completed, failed, cancelled, and unknown outcomes are available as explicit demo scenarios.
- Every interactive control has an accessible name and keyboard focus. TV navigation also accepts directional keys outside native inputs.
- The TV view offers no execution controls. The remote always identifies its selected device and disables actions when unavailable.
- Synthetic operations validate against the existing operation registry; lifecycle labels cover every protocol job state.
- Browser checks exercise switching devices, simulated completion/cancellation, unknown outcomes, offline gating, viewport overflow, keyboard navigation, and the absence of external/network command requests.

## Next boundary

Browser trust and separate, revocable client identities need their own review before this interface connects to household APIs. Loading a fixture in a real phone browser does not establish secure pairing or hardware control.

## Visual review

The first browser screenshots showed that the placement illustration pushed the phone controls too far down the page. The phone now uses a smaller illustration and compact action buttons with explicit labels. Desktop action labels were enlarged, and the TV spacing was tightened to fit its 1080 px viewport. All screenshots use synthetic fixtures.
