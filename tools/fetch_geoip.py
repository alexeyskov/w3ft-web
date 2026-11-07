#!/usr/bin/env python3
"""Download the country database for the page's default language.

DB-IP "IP to Country Lite" (https://db-ip.com, CC BY 4.0; the page credits
it). It is published monthly; run again to update, the server re-reads the
file within six hours. Written to var/geoip/dbip-country-lite.csv.gz.
"""
from __future__ import annotations

import argparse
import datetime
import os
from pathlib import Path
import sys
import tempfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.geoip import load_ranges  # noqa: E402

URL = "https://download.db-ip.com/free/dbip-country-lite-{month}.csv.gz"


def months(today):
    # A month's file appears in its first days; until then use the last one.
    previous = (today.replace(day=1) - datetime.timedelta(days=1))
    return [today.strftime("%Y-%m"), previous.strftime("%Y-%m")]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "var/geoip/dbip-country-lite.csv.gz")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for month in months(datetime.date.today()):
        url = URL.format(month=month)
        request = urllib.request.Request(url, headers={"User-Agent": "wc3ft-web geoip download"})
        handle, name = tempfile.mkstemp(dir=args.output.parent, suffix=".csv.gz")
        temporary = Path(name)
        try:
            with os.fdopen(handle, "wb") as file:
                try:
                    with urllib.request.urlopen(request, timeout=120) as response:
                        while chunk := response.read(1 << 20):
                            file.write(chunk)
                except urllib.error.HTTPError as error:
                    if error.code == 404:
                        continue
                    raise
            ranges = load_ranges(temporary)
            if not len(ranges[4]):
                raise ValueError("no ranges of the CIS countries")
            temporary.chmod(0o644)  # read by the server's own user in the container
            os.replace(temporary, args.output)
        finally:
            temporary.unlink(missing_ok=True)
        print(f"{args.output}: DB-IP {month}, {len(ranges[4])} IPv4 and {len(ranges[6])} IPv6 ranges of the CIS countries")
        return
    raise SystemExit("No DB-IP country database for this or the previous month")


if __name__ == "__main__":
    main()
