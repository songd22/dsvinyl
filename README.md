# dsvinyl

A cozy, full-screen "now playing" screen for Spotify. Leave it up like a clock: big album art, a slowly spinning tinted disc, and colours drawn from the cover. When nothing is playing, it shows the time.

Plain HTML, CSS and JS. No build step, no dependencies.

## Quick start

1. **Turn on GitHub Pages.** In this repo, go to **Settings → Pages**. Under *Build and deployment*, set *Source* to **Deploy from a branch**, pick **main** and **/ (root)**, then click **Save**. After a minute the site is live at <https://songd22.github.io/dsvinyl/>.
2. **Bookmark** <https://songd22.github.io/dsvinyl/> on the device you'll leave it on.
3. **Do the one-time Spotify setup** from the card that appears:
   - Open the Spotify Developer Dashboard and create an app (tick *Web API*).
   - Copy the Redirect URI shown on the card into the app's settings, exactly as shown.
   - Paste the app's **Client ID** into the card (no secret needed), then click **Connect Spotify**.

That's it. From then on, the bookmark opens straight to the display.

Double-click (or double-tap) for fullscreen. Space plays or pauses, ← → skip. Move the mouse to show the controls.

## Settings

Open settings with the gear next to the playback controls, or press **S**. Close with **Esc**, the gear, or a click outside. Changes apply straight away and are remembered on that device.

- **Visualizer:** soft light along the bottom of the screen and a few glints drifting across the disc, tinted by the album. *Ambient* (default) flows gently while music plays and settles when paused. *Mic* follows the music in the room: bass lights the middle, highs the edges, and beats pulse the light. It adjusts itself to quiet and loud songs alike. It asks for the microphone only when you pick it, and nothing leaves your device. If the mic isn't allowed or available, it falls back to Ambient. *Off* turns it off. **Intensity** (Subtle / Normal / Vivid) sets how bright it gets. Press **D** to show a small debug readout of the levels.
- **Clock:** show or hide it, 12h or 24h, with or without the date.
- **Evening mode:** gently warms and dims the screen at night (9 pm to 6 am by default; set your own times).
- **Progress line:** show or hide it.
- **Spotify:** see which account is connected, **Disconnect**, or **Reset setup** to start over with a new Client ID.
- **Restore defaults** at the bottom resets the display settings.

## Troubleshooting

- **Nothing showing?** Start playing something in Spotify on any device, so there's an active device.
- **Controls do nothing?** Play, pause and skip need **Spotify Premium** and an active device. New Spotify apps start in development mode, where Spotify may also require the app owner to have Premium.
- **Start over:** use **Reset setup** in settings, or open the page with `?reset` on the end (for example `https://songd22.github.io/dsvinyl/?reset`). This clears the saved Client ID and sign-in.

## Running locally

```bash
python3 -m http.server 8888
```

Open <http://127.0.0.1:8888> (use `127.0.0.1`, not `localhost`). The setup card shows the local Redirect URI, which you can add to the same Spotify app alongside the Pages one.
