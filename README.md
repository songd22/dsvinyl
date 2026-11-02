# dsvinyl

A cozy, full-screen "now playing" display for Spotify. A walnut turntable sits in warm lamplight with the album sleeve leaning against the wall. Leave it up like a screensaver.

Plain HTML, CSS and JS. No build step, no dependencies. The album art is the only image.

## Setup

1. **Create a Spotify app.** Go to <https://developer.spotify.com/dashboard>, click *Create app*, and tick *Web API*.
2. **Add the redirect URI.** In the app's settings, add this URI exactly, including the trailing slash:
   ```
   http://127.0.0.1:8888/
   ```
3. **Paste your Client ID.** Copy the app's *Client ID* (not the secret, which is never needed) into the constant at the top of `app.js`:
   ```js
   const CLIENT_ID = 'your-client-id';
   ```
4. **Run the server** from this folder:
   ```bash
   python3 -m http.server 8888
   ```
5. **Open <http://127.0.0.1:8888>.** Use `127.0.0.1`, not `localhost`, because Spotify rejects `localhost` redirect URIs. (If you open `localhost`, the page switches to `127.0.0.1` for you.) Click **Connect Spotify** and approve. You only need to do this once.
6. **Go fullscreen** by double-clicking anywhere.

## Using it

| | |
|---|---|
| Space | play / pause |
| ← / → | previous / next |
| Click the record or tonearm | play / pause |
| Double-click | toggle fullscreen |
| Move the mouse | show the controls; they hide again with the cursor after 3 s |

The screen stays awake while the page is visible (Screen Wake Lock, where the browser supports it).

## Troubleshooting

- **Nothing shows up.** Start playing something in Spotify on any device (phone, desktop app, speaker) so there is an active device. The display checks again every 20 s when idle, and every 5 s while music plays.
- **The controls do nothing.** Playback control needs **Spotify Premium** and an active device. Without them, the scene quietly goes back to the real state.
- **Development-mode apps.** New Spotify apps start in development mode. Spotify may require the app owner's account to have Premium, and other people must be added under *User Management* before they can sign in.
- **"Connect Spotify" came back.** Your sign-in was revoked or expired (for example, you removed the app's access in your Spotify account). Click it to sign in again.
- **Redirect error from Spotify.** The redirect URI in the dashboard must match `http://127.0.0.1:8888/` exactly.

## Notes

- Sign-in uses Authorization Code with PKCE. Only the Client ID lives in the code. The refresh token is kept in `localStorage`, and the access token is refreshed before it expires.
- It is built to run overnight. Polling pauses while the tab is hidden, backs off (up to 60 s) when the network drops, honours Spotify's `Retry-After`, and resumes on its own after sleep or a Wi-Fi drop.
- With *reduce motion* turned on in your OS, the record stays still and the tonearm moves without animation.
