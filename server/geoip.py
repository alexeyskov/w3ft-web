"""Default page language from the visitor's country.

A page without a chosen language asks /api/locale once: Russian for the CIS
countries, English for the rest of the world, null when the country is
unknown (database missing, local or private address); the page then follows
the browser. A language chosen on the page always wins.

Countries come from DB-IP "IP to Country Lite" (CC BY 4.0, https://db-ip.com),
downloaded by tools/fetch_geoip.py. Only the ranges of RUSSIAN_COUNTRIES are
kept in memory (≈20 000 merged ranges, 0.3 s to load). The file is re-read
when it changes, so a monthly update needs no restart.
"""
from __future__ import annotations

import asyncio
import bisect
import gzip
import ipaddress
import logging
from pathlib import Path
import re

from aiohttp import web

# Members of the CIS (Armenia, Azerbaijan, Belarus, Kazakhstan, Kyrgyzstan,
# Moldova, Russia, Tajikistan, Uzbekistan) and its associate Turkmenistan.
RUSSIAN_COUNTRIES = frozenset({"AM", "AZ", "BY", "KG", "KZ", "MD", "RU", "TJ", "TM", "UZ"})
log = logging.getLogger(__name__)


class Ranges:
    """Merged, sorted address ranges of one IP version."""

    def __init__(self, ranges):
        merged = []
        for start, end in sorted(ranges):
            if merged and start <= merged[-1][1] + 1:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        self.starts = [start for start, _ in merged]
        self.ends = [end for _, end in merged]

    def __len__(self):
        return len(self.starts)

    def __contains__(self, value):
        index = bisect.bisect_right(self.starts, value) - 1
        return index >= 0 and value <= self.ends[index]


def load_ranges(path, countries=RUSSIAN_COUNTRIES):
    """Ranges of `countries` from a DB-IP country CSV (optionally gzipped):
    rows of first address, last address and ISO country code."""
    path = Path(path)
    found = {4: [], 6: []}
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="ascii", newline="") as rows:
        for number, line in enumerate(rows, 1):
            fields = line.strip().split(",")
            if len(fields) != 3:
                raise ValueError(f"{path.name}:{number}: expected first address, last address, country")
            if fields[2] not in countries:
                continue
            first, last = ipaddress.ip_address(fields[0]), ipaddress.ip_address(fields[1])
            if first.version != last.version or last < first:
                raise ValueError(f"{path.name}:{number}: invalid range")
            found[first.version].append((int(first), int(last)))
    return {version: Ranges(ranges) for version, ranges in found.items()}


def peer_address(request):
    try:
        return ipaddress.ip_address(request.remote or "")
    except ValueError:
        return None


def behind_proxy(address):
    # The site's reverse proxy (Caddy from compose.yaml) connects from a
    # loopback or private address.
    return address is not None and (address.is_loopback or address.is_private)


def client_address(request):
    """The visitor's public address: behind the reverse proxy, the address
    the proxy appended to X-Forwarded-For."""
    address = peer_address(request)
    if address is None:
        return None
    if behind_proxy(address):
        forwarded = request.headers.get("X-Forwarded-For", "").split(",")[-1].strip()
        if forwarded:
            try:
                address = ipaddress.ip_address(forwarded)
            except ValueError:
                return None
    if address.version == 6 and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address if address.is_global else None


class GeoLanguage:
    def __init__(self, path, countries=RUSSIAN_COUNTRIES, refresh=6 * 3600):
        self.path = Path(path) if path else None
        self.countries = countries
        self.refresh = refresh
        self.ranges = None
        self.loaded = None  # (mtime, size) of the loaded file

    def language(self, request):
        # A CDN in front of the site (Cloudflare) names the country itself;
        # the address the proxy sees is then the CDN's. XX: unknown, T1: Tor.
        country = request.headers.get("CF-IPCountry", "").upper()
        if behind_proxy(peer_address(request)) and re.fullmatch(r"[A-Z]{2}", country) and country not in ("XX", "T1"):
            return "ru" if country in self.countries else "en"
        address = client_address(request)
        if address is None or self.ranges is None:
            return None
        return "ru" if int(address) in self.ranges[address.version] else "en"

    async def handler(self, request):
        return web.json_response({"language": self.language(request)}, headers={"Cache-Control": "no-store"})

    def reload(self):
        info = self.path.stat()
        if (info.st_mtime_ns, info.st_size) != self.loaded:
            self.ranges = load_ranges(self.path, self.countries)
            self.loaded = (info.st_mtime_ns, info.st_size)
            log.info("Country database %s: %d IPv4 and %d IPv6 ranges of %s", self.path.name,
                     len(self.ranges[4]), len(self.ranges[6]), ", ".join(sorted(self.countries)))

    async def watch(self, app):
        async def run():
            missing_reported = False
            while True:
                try:
                    await asyncio.to_thread(self.reload)
                except FileNotFoundError:
                    if not missing_reported:
                        log.warning("No country database at %s (make geoip); pages use the browser language", self.path)
                        missing_reported = True
                except (OSError, ValueError, EOFError) as error:
                    log.warning("Country database %s not loaded: %s", self.path, error)
                await asyncio.sleep(self.refresh)

        task = asyncio.create_task(run()) if self.path else None
        yield
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
