# Warcraft® III: The Frozen Throne® Web

The Frozen Throne Reborn is a fan project that runs the classic Windows game in a browser. The original x86 code is translated to C and compiled to WebAssembly; OpenGL is implemented with WebGL 2 and audio with Web Audio. The launcher includes saves, graphics settings, fullscreen and virtual LAN lobbies.

Based on [nfsu2-web](https://github.com/th0mk/nfsu2-web) by th0mk, using its MIT-licensed lifter and CPU helpers, with original work by Talha Müderrisoğlu. The game-specific runtime and multiplayer protocol are adapted for Warcraft III.

> Not affiliated with, endorsed by, or sponsored by Blizzard Entertainment. **To build or deploy this project, you must own a valid license for Warcraft III: The Frozen Throne and supply the files from your own lawfully obtained installation.** Game files, generated game code and compiled game modules are not included in this repository.

## What you need

- **The game:** your own licensed copy and a complete classic 32-bit Windows installation with The Frozen Throne. The tested binaries report **1.26.0.6401**. Reforged and arbitrary other patches are not supported just by copying their data. See the [tested binary hashes and compatibility notes](docs/SELF_HOSTING.md#compatible-game-files).
- **To build:** macOS or Linux, Python 3.11+, a recent Node.js with WebAssembly threads and tail calls, FFmpeg (`ffmpeg` and `ffprobe`), Make, and [wasi-sdk 34](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34). Use Linux/WSL for Windows development. Optional localization preparation also needs `bsdtar`.
- **To play:** a desktop browser with WebGL 2, OffscreenCanvas, SharedArrayBuffer and WebAssembly threads. Chromium and Firefox are tested. A browser without WebAssembly tail calls (Safari before 18.2, Chrome before 112, Firefox before 121) gets a compatible build of the same code; by the features it uses, that means Safari 17 or newer, Chrome 96 or Firefox 114. Desktop WebKit has also passed a short mixed-browser LAN match with Chromium, in both host/guest directions; this does not establish compatibility with every Safari/iOS version or custom map. Use localhost or HTTPS.
- **On phones and tablets:** Chrome on Android, held sideways; a recent phone with 8 GB of memory or more is advisable. Startup on a physical iPhone has also been confirmed by the maintainer. The runtime grows guest memory as the game allocates it instead of committing the entire guest window at startup. Compiled code, graphics and browser overhead still require additional memory. See [port status](docs/port-status.md#mobile-browsers) for device coverage and remaining limitations.

## Build

Start in a fresh checkout. Create a ZIP from your own installed game, containing its files at the root or inside one enclosing directory:

```sh
make setup
.venv/bin/python tools/prepare_game.py "/absolute/path/to/your-installation.zip"
make inspect media maps
```

Download the wasi-sdk 34 archive for your machine and unpack it under `var/toolchains/`, retaining its `wasi-sdk-*` directory. Then:

```sh
make lift-runtime
make runtime
make boot-set   # needs Playwright: startup set and ordered background download plans
```

This creates your own `var/game`, `var/maps`, `var/lift-compact`, `var/runtime` and `var/reports`. Generated C and WASM are derived from the supplied game and stay outside Git. Updating JavaScript alone does not install compiler or guest-memory improvements: existing builds need regenerated translation outputs and both WASM variants. See the [upgrade instructions](docs/SELF_HOSTING.md#4-translate-and-compile). The self-hosting guide also covers using an installed directory, alternate SDK locations, languages, maps and rebuilding for different binaries. No prebuilt `var/` download is required.

## Play

```sh
./run.sh
```

Open **http://localhost:8080/** and press **Play**. Select campaigns and maps inside Warcraft. Saves remain in the browser and can be exported from the launcher. Print Screen saves the game's screenshot as a PNG in the browser's downloads. If your base installation is English, start with `./run.sh --base-language en`.

Startup intros are skipped. After the critical startup download, remaining data is cached automatically while you play: menus, multiplayer, match resources, then campaign content. Immediate game reads take priority over background downloads. Completed blocks are reused on later visits; no download controls or manual action are required. **Game → Game data on this device** shows stored data. See the [download plan and caching details](docs/SELF_HOSTING.md#faster-first-launch).

On a touch screen, a tap is a click, a long press or a two-finger tap is a right click, two fingers dragged scroll the map and a pinch zooms. The buttons beside the picture open the device keyboard (for chat, press its Enter), send Escape and leave fullscreen.

For LAN play, join the same site lobby, launch both clients and open **Local Area Network** in Warcraft. One player hosts the match; the others join it. Battle.net is not implemented. Other devices require HTTPS; [compose.yaml](compose.yaml) and [deploy/Caddyfile](deploy/Caddyfile) provide a deployment starting point.

There are four shared lobbies with 200 seats each, regardless of game language. Play joins the first lobby with a free seat; temporary overflow lobbies appear when needed. You can also create a lobby or join one by code.

**Games over LAN** counts started matches, including a LAN host playing against computer opponents. Several players in the same match count as one game; waiting rooms and loading screens do not count.

The browser profile also keeps Warcraft's LAN name and game settings when you close the game. On the site's **Saves** tab, **Save** downloads a JSON backup of saves and settings; **Load** imports that backup.

After a failure, **Report issue** lets the player review and send the saved log and technical details, with an optional comment. Sending is opt-in. Reports are grouped in the password-protected `/admin` Issues tab, with counts, filters, status, notes and log downloads. The private SQLite database is stored in `var/issues` locally or the persistent `issue_data` Docker volume. See [self-hosting](docs/SELF_HOSTING.md#issue-reports) for storage and limits.

Server owners can enable a password-protected `/admin` page to monitor CPU, memory, disk space and network traffic, view visitor activity over time, inspect active connections and end individual sessions. The activity chart keeps 90 days of concurrent page counts (on site and in game) and running LAN match counts, not unique visitor records. History survives server restarts. The panel is disabled until a password is configured; see the [admin setup instructions](docs/SELF_HOSTING.md#private-admin-panel).

**Hosting serves your game files and game-derived WASM to connected browsers.** Owning a game copy does not itself grant permission to redistribute those files or operate an Internet matchmaking service. Read the [publication and hosting notes](docs/LEGAL.md) before making a deployment public.

## How it works

- **`tools/`** inspects the installation, translates four PE images and builds the WASM module.
- **`runtime/`** implements the guest CPU, PE loading and dispatch.
- **`web/runtime/`** supplies Win32, graphics, audio, persistence and virtual sockets in browser workers.
- **`web/src/`** provides the launcher, local saves, settings and OPFS game-data cache.
- **`server/`** serves files with byte ranges/compression and routes lobby traffic; the game executes on the client.

Campaign startup, save/load and short LAN matches have been exercised. Full campaign completion, every custom map and all browsers are not verified. See [port status](docs/port-status.md) and [runtime documentation](docs/runtime-contract.md).

## Development

```sh
make test
```

Browser tests require Playwright/Chromium and, where documented, a running local server. Start with [tests/browser_smoke.py](tests/browser_smoke.py) for the launcher, [tests/runtime_lan_browser.py](tests/runtime_lan_browser.py) for two real game clients, [tests/runtime_dropout_browser.py](tests/runtime_dropout_browser.py) for a player who crashes, closes the page, freezes or loses the connection in a three-player match, or [tests/runtime_touch_browser.py](tests/runtime_touch_browser.py) for touch input on an emulated phone; [tests/runtime_site_browser.py](tests/runtime_site_browser.py) `--browser firefox` launches the real game in another engine, and `--no-tail-calls` on the compatible build.

## Credits

- [th0mk/nfsu2-web](https://github.com/th0mk/nfsu2-web): static recompilation tools, CPU helpers and launcher layout. The vendored source revision and original notices are preserved in [vendor/nfsu2/](vendor/nfsu2/README.md).
- Talha Müderrisoğlu's [NFSU2Recomp](https://github.com/TalhaMudo/NFSU2Recomp): the original recompiler and macOS runtime credited by that MIT-licensed upstream snapshot. Its later revisions are not imported by this project.
- [StormLib](https://github.com/ladislav-zezula/StormLib): a reference for MPQ sector behavior.
- [DB-IP](https://db-ip.com): optional IP-to-country Lite data under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Dependencies and redistribution notes are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Acknowledgments

Thanks to **OpenAI Codex** and **Claude Code** for their help with development, debugging, and testing.

## License

Project source is available under the [MIT License](LICENSE), with the retained notices for borrowed components. This license does **not** cover Warcraft executables, archives, maps, music, cinematics, fonts, modified game assets, or the game-derived portions of generated C/WASM. Obtain the applicable rights separately.

Warcraft, Warcraft III: The Frozen Throne and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc., in the U.S. and/or other countries. Their use here identifies the game this project targets and does not imply approval. See [LEGAL.md](docs/LEGAL.md).
