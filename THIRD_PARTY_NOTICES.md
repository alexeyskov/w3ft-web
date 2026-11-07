# Third-party notices

The project MIT license covers project source and the borrowed MIT components identified below. It does not relicense any game data or change the licenses of external dependencies. Existing copyright and license notices must travel with redistributed copies of the components they cover.

## nfsu2-web and NFSU2Recomp

Source: https://github.com/th0mk/nfsu2-web

Vendored revision: `3e61f9c37cb7ce4084dde182047c1b782bd9ac1a`.

The files in `vendor/nfsu2/provenance.json` are unmodified upstream copies, used by `tools/lift_wc3.py`. `runtime/cpu.h` adapts the upstream CPU ABI and arithmetic helpers. The launcher layout in `web/styles/main.css` is also adapted from nfsu2-web and retains its full MIT notice. Changes for Warcraft include a separate memory/dispatch model, PE discovery, a game-specific host and a different rendering/network protocol.

The upstream license names **th0mk** and **Talha Müderrisoğlu**, the author of the original recompiler and macOS runtime. These credits describe the borrowed components; they do not identify either author as the developer or endorser of this Warcraft port. The project uses the pinned MIT snapshot, not later revisions or their license terms.

The complete original notice is retained in `vendor/nfsu2/LICENSE`. The root `LICENSE` also retains these copyright notices and the MIT permission/warranty text. Keep both when distributing this source tree. Retain the corresponding notices when distributing binaries built from these components.

## Launcher icons

The Discord glyph embedded in `web/index.html` comes from [Simple Icons](https://github.com/simple-icons/simple-icons/blob/develop/icons/discord.svg), provided under [CC0 1.0 Universal](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md). Discord's name and logo remain trademarks of their respective owner.

## MPQ format reference

`tools/mpq_reader.py` uses mpyq for MPQ headers/tables and follows sector-storage behavior documented by [StormLib](https://github.com/ladislav-zezula/StormLib/blob/master/src/SFileReadFile.cpp). StormLib is a format/behavior reference; its C/C++ library is not vendored or linked by this project. The mpyq package has its own license below.

## Installed dependencies and build tools

These are fetched or installed separately, rather than copied into this source tree. The following describes the pinned direct Python dependencies; it is not a replacement for their full notices or those of transitive dependencies.

| Component | Use | License / upstream |
| --- | --- | --- |
| aiohttp 3.13.2 | HTTP and WebSocket server | Apache-2.0 AND MIT; https://github.com/aio-libs/aiohttp |
| Capstone 5.0.6 | x86 decoding for the lifter | BSD-3-Clause, with additional bundled notices; https://github.com/capstone-engine/capstone |
| pefile 2024.8.26 | PE inspection/translation | MIT; https://github.com/erocarrera/pefile |
| mpyq 0.2.5 | MPQ table parsing | BSD-2-Clause; https://github.com/eagleflo/mpyq |
| fontTools 4.68.0 | Optional local font preparation | MIT; https://github.com/fonttools/fonttools |
| wasi-sdk / LLVM / wasi-libc | Compiler, builtins and linked C runtime | Multiple licenses; https://github.com/WebAssembly/wasi-sdk and https://github.com/WebAssembly/wasi-libc/blob/main/LICENSE |
| FFmpeg | Optional local cinematic conversion | Build-dependent LGPL/GPL terms; https://ffmpeg.org/legal.html |
| libarchive / bsdtar | Optional local archive extraction | BSD-family notices; https://github.com/libarchive/libarchive |
| Playwright / Chromium | Optional browser tests | Their respective upstream licenses; https://github.com/microsoft/playwright and https://www.chromium.org/chromium-projects/ |

Keep the installed packages' license files when redistributing an environment or container. A WASM build links portions of the toolchain runtime; include the licenses/notices applicable to the actual SDK libraries used. In particular, wasi-libc is multi-licensed and includes separately licensed portions. This document does not claim that the project MIT license covers them. The package step copies the project notices, not a complete SDK license inventory. Python, Node.js and container base images also retain their own notices.

## Optional DB-IP country database

The optional **DB-IP IP to Country Lite** database is provided by [DB-IP](https://db-ip.com) under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). The download and terms are at https://db-ip.com/db/lite.php.

`tools/fetch_geoip.py` downloads the database into the ignored `var/geoip/` directory. The server selects and merges country ranges for its language decision. No database is included in this repository. Keep the DB-IP attribution, license link and notice of processing when sharing that data or a derived dataset. Pages using it must retain the visible **IP Geolocation by DB-IP** link; the launcher includes that link in its changelog dialog.

## Warcraft and other game content

Warcraft, Warcraft III: The Frozen Throne and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc., in the U.S. and/or other countries. This project is not affiliated with, endorsed by, or sponsored by Blizzard Entertainment.

Original game binaries, archives, artwork, sound, cinematics, maps and fonts retain their applicable rights. Custom maps may contain additional third-party content. Locally generated game translations, converted movies and modified fonts do not become MIT-licensed because these tools produced them. The bundled game's Friz Quadrata/Nimrod fonts are not supplied or relicensed here; glyph merging is not a permission to modify or distribute those fonts.

See `docs/LEGAL.md` for publication/hosting boundaries and `docs/SELF_HOSTING.md` for preparing local files from your own installation.
