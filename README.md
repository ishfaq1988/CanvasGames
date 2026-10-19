# Canvas Games

Four HTML5 canvas games you can play **against the computer**, **with two players on one device**, or **with two players on two devices over the internet**. Online play uses a direct peer-to-peer WebRTC connection, so there's no game server.

| Game | File | Online controls |
|---|---|---|
| Neon Pong | `games/pong.html` | W/S, ↑/↓, mouse or touch |
| Neon Air Hockey | `games/airhockey.html` | Mouse or touch (keys also work) |
| Light Cycles (Tron) | `games/tron.html` | WASD / arrows, swipe on touch |
| Tank Duel | `games/tanks.html` | WASD / arrows + Space; touch: drag left side, tap right side |

Open `index.html` for the gallery and an embedded demo.

## Add a game to your site

Upload the whole folder (it's only static files: no build step, no backend), then embed a game:

```html
<iframe src="https://your-site.com/canvasgames/games/tanks.html"
        width="960" height="600" style="border:0"
        allow="clipboard-write; fullscreen; web-share"></iframe>
```

The game scales to whatever size the iframe is. You can also link straight to a game page.

To try it locally, serve the folder over HTTP (for example `npx http-server .`) and open `http://localhost:8080`. Opening it as a `file://` page won't load the online module.

## How two devices connect

1. **Room link (default).** The host clicks *Create game & get link* and sends the link or the 6-letter room code. Free public Nostr relays carry only the one-time encrypted handshake, through the bundled [Trystero](https://github.com/dmotz/trystero) library. After that, all game data flows **device to device** over a WebRTC data channel.
2. **Copy-paste codes (zero relays).** Under *No link? Connect by copy-pasting codes instead*, the host copies an invite code and sends it by any chat app. The guest pastes it and sends back a reply code. No relay or matchmaking service is involved at all.

Both modes use a free public **STUN** server once, at connect time, so each device can find its public address. On some strict networks (certain mobile carriers, company firewalls) a direct connection is impossible. Those players need a **TURN** relay, which you can add in the config below.

### In a match
- The **host** runs the game and streams compact snapshots 60 times a second. The **guest** sends its input and renders the host's snapshots with smoothing, so both screens always agree.
- In Air Hockey the guest's view is rotated, so each player defends the goal at the bottom of their own screen.
- The menus also handle rematches, ping display and disconnect detection.

## Optional configuration

Define this before the scripts load (e.g. in each game page, or in your own copy):

```html
<script>
  window.CANVASGAMES_CONFIG = {
    appId: 'my-site-games',                 // separates your rooms from other sites
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }
    ],
    shareUrl: function (roomId, gameId) {   // where invite links point
      return 'https://your-site.com/play/' + gameId + '#join=' + roomId;
    }
  };
</script>
```

If you set `shareUrl` to a page that embeds the game in an iframe, pass the hash through to the iframe (e.g. `iframe.src = 'games/pong.html' + location.hash`).

## Project layout

```
index.html            gallery + embed demo
games/*.html          one self-contained file per game
lib/p2p.js            WebRTC connections: room links + copy-paste codes
lib/shell.js          menus, game loop, input, sound, host/guest sync
lib/vendor/           Trystero 0.25.4 (MIT), bundled so no CDN is needed
```

### Writing another game
Each game passes one definition object to `GameShell.start(def, '#game')`, with `init`, `step`, `readInput`, `ai`, `winner` and `render`, plus optional `snapshot`/`applySnapshot`/`interpolate` for compact network updates. The shell provides CPU, same-device and online modes for free. The comment at the top of `lib/shell.js` documents the full contract.
