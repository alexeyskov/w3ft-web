# Startup and cache download diagnostics — 9 November 2026

## Reported launch

The supplied `warcraft-last-game (5).log` is from Chrome 128 on Windows.
It ends with `GuestFault: Video load timed out`, before any rendered game
objects (`frames: 2`, `draws: 0`). Times below are UTC, as written in the log.

| Interval | Elapsed |
| --- | ---: |
| Play 15:01:55.840 → LAN ready 15:01:55.991 | 0.15 s |
| LAN ready → runtime worker start 15:03:47.597 | 111.61 s |
| WASM compilation | 0.50 s |
| Compilation finished → instance ready 15:03:51.304 | 3.21 s |
| Guest entrypoint 15:03:51.457 → video fault 15:04:13.195 | 21.74 s |
| Play → fatal fault | 137.36 s |

The long first interval covers `prepareGame`; the old log does not break it
down into WASM transfer, menu resources, OPFS writes or browser/network waits.
It does **not** show a slow compiler: compilation itself took half a second.
The video fault has the old `{id: 1}` details, without the newer
`videoOperation`/`reason` fields. This matches the already identified timeout
handling bug. The log has no build ID, so its exact deployed build/domain
cannot be proven from this file alone.

## Limited network observations collected earlier

These read-only public HTTP checks were completed **before** the user's
instruction to stop accessing the VPS. No SSH login, configuration change,
deployment or further public request was made after that instruction.
Transfers were bounded to approximately 9.25 MiB at `wc3ft.ru` and 6.25 MiB
at `w3ft.online`, plus small JSON/JS responses. Fresh curl requests used HTTP/2.

| Domain / range | Time to headers | Total |
| --- | ---: | ---: |
| `wc3ft.ru`, 256 KiB | 0.24 s | 0.59 s |
| `wc3ft.ru`, 1 MiB | 0.26 s | 0.79 s |
| `wc3ft.ru`, 4 MiB, first sample | 0.25 s | 16.33 s |
| `wc3ft.ru`, 4 MiB, repeat | 0.27 s | 10.74 s |
| `w3ft.online`, 256 KiB | 0.46 s | 0.58 s |
| `w3ft.online`, 1 MiB | 0.34 s | 0.76 s |
| `w3ft.online`, 4 MiB | 0.28 s | 0.89 s |
| `w3ft.online`, 1 MiB, repeat | 0.41 s | 0.82 s |

The direct site's slow samples spent most of their time **after** headers,
while transferring the body. This points towards throughput, congestion,
origin egress/load or connection behavior; it does not identify which one.
The second domain is Cloudflare-fronted, and the two domains served different
video-bridge JS versions at that moment (new timeout handling at `wc3ft.ru`,
old handling at `w3ft.online`). They are not a controlled comparison of the
same origin and deployment. Status response caching also does not establish
whether a particular archive range was served from an edge cache.

No VPS-side CPU, disk, origin-loopback or provider-bandwidth measurements
were available. These samples cannot establish that the VPS needs upgrading
or that every player's network will show the same result.

## Local code checks and changes

The actual aiohttp file-serving code, on this development Mac over loopback
with a synthetic file, returned 256 KiB/1 MiB/4 MiB in 1.0/1.0/1.8 ms. The
4 MiB time to first byte was 0.6 ms. This rules out an inherent low transfer
ceiling in this code on this machine; it is not a benchmark of the VPS's
hardware, Caddy, disk or external connection.

Startup preload already has six concurrent downloads. Full manual preload
uses one contiguous range at a time, up to 8 MiB; its progress previously
advanced only after a full range. Increasing concurrency blindly may just
divide a constrained outgoing connection among more requests.

Both paths now use streaming progress, immediate cancellation and a 30-second
idle timeout. Terminal worker messages are sent **after** OPFS index/file
flush and close, avoiding a race with the main page terminating that worker.
The following diagnostics are appended to the existing downloadable log:

- Deterministic runtime build ID covering host JS and both WASM build hashes.
- Menu-manifest elapsed time and whether a boot set was found.
- WASM HTTP-cache validation or transfer, header/body timing and byte counts.
- Cache opening/writing/closing time, bytes skipped because already cached,
  request counts, decoded bytes, completed transfer bytes, slowest file and
  elapsed time; an in-progress snapshot every ten seconds.

Worker `bodyMs` sums request durations, which may overlap with six concurrent
startup downloads. `transferBytes` counts completed responses using their
Content-Length; `decodedBytes` includes bytes received from partial responses.
Browser time to headers includes connection/queue/proxy time and is not a
pure measurement of origin server CPU.

`tests/preload_browser.py` uses original synthetic fixture bytes and real
Chromium OPFS: initial download, immediate repeat with zero asset/WASM
downloads, cancellation of manual/startup preload and stalled-response timeout.
The package identity unit tests cover changes to JS and both WASM hashes.

The packaged JS build is `wc3-e8b6112f4009a19ce1b04df8`; neither WASM binary
was rebuilt. Local recordings reached the real Russian/English main menus
in approximately 9/6 seconds and refreshed both boot sets. A further real-game
Chromium run deliberately stalled all video metadata loads: the cinematic was
skipped and the game reached its menu (87 frames, no browser errors). Artifacts
are under ignored `var/qa/video-load-timeout-new`. These checks used macOS;
the affected physical Windows device was not tested.

## Repeating a bounded diagnosis locally

`tools/measure_downloads.py` requires an explicit origin, uses stdlib Python,
and defaults to 2.5 MiB total. It rejects plans exceeding 10 MiB. Run it only
where authorized. To measure the origin from the VPS itself later:

```bash
python3 tools/measure_downloads.py http://127.0.0.1:8080
```

Compare that with the same ranges through HTTPS from an affected device.
Fast loopback and slow HTTPS points outside the file-read path; slow loopback
requires checking origin CPU, disk, compression warmup and concurrent load.
The new client logs separately show whether time was spent transferring files
or opening/writing the browser's cache. They provide measurements for an
optimization decision instead of inferring a root cause from one total time.
