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

## Troubleshooting

- **Nothing showing?** Start playing something in Spotify on any device, so there's an active device.
- **Controls do nothing?** Play, pause and skip need **Spotify Premium** and an active device. New Spotify apps start in development mode, where Spotify may also require the app owner to have Premium.
- **Start over:** open the page with `?reset` on the end (for example `https://songd22.github.io/dsvinyl/?reset`). This clears the saved Client ID and sign-in.

## Running locally

```bash
python3 -m http.server 8888
```

Open <http://127.0.0.1:8888> (use `127.0.0.1`, not `localhost`). The setup card shows the local Redirect URI, which you can add to the same Spotify app alongside the Pages one.
