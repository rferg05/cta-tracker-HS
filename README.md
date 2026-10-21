# CTA Tracker

Home Screens module: a live map of CTA trains and buses around one stop, plus the next arrivals in each direction.

Out of the box it's centered on Division (Blue Line) at Milwaukee/Division/Ashland, with the 56 Milwaukee, 70 Division, and 9 Ashland buses.

## Reading it

- **Map**: north is up. Trains are long Blue Line rail cars lying along the track, with a chevron toward the front. Buses are round badges in their route's color, with a bus pictogram and a pointed nose aimed the way they're going. Vehicles are drawn slightly to the right of their street, so buses going opposite ways don't overlap. Where two would still overlap (a train over Milwaukee and a 56 at Division, say), they're pushed apart so both show; a vehicle that already passed gives way to one still coming. Time tags pick whichever side of their vehicle is clear. The *Vehicle icons* setting also offers round badges for both, or square trains with round buses. The Blue Line is drawn only as far as Monroe: the Forest Park branch past it is too far out to matter for Division.
- **Almost there**: a bus within 4 stops of Division is drawn larger with a halo, and its tag and board chip show the stops left ("2 stops", "next stop"). For the 56, those last 4 stops are also drawn as a bright stretch of route with stop dots, in both directions, so a bus inside it stands out.
- **Bright with a time tag**: headed toward the center stop, with its predicted arrival there.
- **Faded**: already past the center stop. Turn off *Show vehicles that already passed* to hide these.
- **Arrivals board**: the next 3 arrivals per route and direction.
  - **Solid chip**: CTA is tracking a real vehicle for that arrival.
  - **Dashed chip with `~`**: Train Tracker is quoting the timetable and no train has been seen yet. These are the arrivals that may not show up.
  - **Amber time**: CTA flags the vehicle as delayed.

To judge whether something will arrive on time, compare a chip's time with the tagged vehicle on the map: how far out it is, and whether it's moving.

## How the markers move

CTA publishes a new bus position about every 30 seconds, and a new train position whenever the train enters the next section of track. The module checks for new positions every 10 seconds, so a new one shows up within 10 seconds of CTA publishing it. Between updates, each marker moves continuously along its real path. Every position starts from what CTA reported and is moved only by CTA's own numbers:

- **Trains** move along the Blue Line track toward their next station and reach it at the time Train Tracker predicts, then wait there until the next update.
- **Buses** move along their route at the speed implied by Bus Tracker's prediction for the center stop (distance left divided by time left, which already accounts for stops and lights). Buses already past the stop use the speed measured between their last two updates.
- **No guessing past the data**: a bus stops moving 90 seconds after its last update, and a train stops at its next station. When an update arrives, the marker glides to the reported spot over one second instead of jumping.

Drawn positions update once a second and the browser animates between them, so motion stays smooth without loading down the Pi.

## Install

1. In the Home Screens editor, open the Plugin Store, choose **Install from URL**, and paste:

   ```
   https://github.com/rferg05/cta-tracker-HS/releases/latest/download/cta-tracker.tar.gz
   ```

   This always points at the newest release. Home Screens doesn't check URL-installed plugins for updates on its own, so to update: Plugin Store > **Installed**, then the download icon on CTA Tracker, then **Install**.
2. Plugin Store > **Installed** > CTA Tracker: enter your **Train Tracker API key** and **Bus Tracker API key**. The keys stay on the Pi. The host proxy adds them server-side, and they never reach the browser.
3. Add the module to a screen. It works best at 960×540 or larger. The layout switches automatically between map-beside-board and map-above-board based on the module's shape.

## Settings

| Setting | Default | |
|---|---|---|
| Bus routes | `56,70,9` | For each route and direction, the stop nearest the center is used, taken from Bus Tracker's route patterns. |
| Blue Line station ID | `40320` (Division) | Train Tracker map ID. The track drawing only covers the Blue Line. |
| Center lat / lon / label | Division station | Moving it re-picks the bus stops. Keep it within about 5 miles of Division so the Blue Line track still draws. |
| Map radius | 1.5 mi | About 10 minutes of bus travel and 4 of train. |
| Vehicle icons | Train as a rail car, buses round | Or round badges for both, or square trains. |
| Emphasize buses within | 4 stops | 0 turns it off. |
| Highlight approach stops for routes | `56` | Comma-separated, e.g. `56,70`. |
| Check vehicle positions every | 10 s | 10–60 s. Markers move smoothly either way. |
| Check arrival times every | 30 s | 15–120 s. |

## API usage

Positions and arrival times are fetched separately. Each check is one request per key: train positions and bus positions every 10 s, then train arrivals and bus predictions every 30 s. Route shapes load once an hour.

| | Per day, defaults | Per day, fastest settings (10 s / 15 s) | Daily limit |
|---|---|---|---|
| Train Tracker key | 11,520 | 14,400 | 100,000 |
| Bus Tracker key | ~11,600 | ~14,500 | 100,000 |
| Home Screens proxy | 16 per minute | 20 per minute | 60 per minute |

Even at the fastest settings each key stays under 15% of its limit. The defaults were measured in the preview at 16 requests per minute. A second module showing the same routes reuses the same proxy responses. As a backstop, the module skips a check rather than going over 50 requests per minute across the whole display.

## Development

```bash
npm install
npm test             # parsers, approaching/passed logic, motion model
npm run preview      # module against a mock CTA feed at http://localhost:5174
npm run build        # dist/bundle.js
```

The preview accepts query parameters for size and any config key, e.g. `?w=520&h=800&layout=stacked&radiusMiles=2`. `fs=24` sets the text size, and `scene=overlap` parks a train and a 56 bus at Division together.

Release tarball:

```bash
mkdir -p release/pkg/cta-tracker/dist
cp manifest.json release/pkg/cta-tracker/
cp dist/bundle.js dist/bundle.js.map release/pkg/cta-tracker/dist/
tar -czf release/cta-tracker-<version>.tar.gz -C release/pkg cta-tracker
```

Attach it to a GitHub release tagged `v<version>`, along with a copy named `cta-tracker.tar.gz` so the `latest/download` URL above keeps working:

```bash
cp release/cta-tracker-<version>.tar.gz release/cta-tracker.tar.gz
gh release create v<version> release/cta-tracker-<version>.tar.gz release/cta-tracker.tar.gz --title v<version>
```

Blue Line track and station data come from the City of Chicago data portal (datasets `xbyr-jnvx` and `8pix-ypme`) and are embedded in `src/blue-line.ts`.
