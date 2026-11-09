"""Owner-only live connection report; read with python -m server.sessions.

No HTTP endpoint or extra listening port. Only current connections are written
to an atomic, owner-readable file in the server's temporary directory.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import tempfile
import time
import uuid


def default_report_path(port=8080):
    return Path(tempfile.gettempdir()) / f"w3ft-presence-{port}.json"


class SessionReport:
    def __init__(self, presence, path, interval=2):
        self.presence, self.path, self.interval = presence, Path(path), interval
        self.instance = uuid.uuid4().hex

    def write(self, payload):
        # mkstemp creates mode 0600 even when the process umask is permissive.
        # Replace, never truncate: SSH readers cannot observe a partial report.
        name = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix=".w3ft-presence-",
                                             dir=self.path.parent, delete=False) as stream:
                name = Path(stream.name)
                json.dump(payload, stream)
                stream.write("\n")
            os.replace(name, self.path)
        finally:
            if name is not None:
                name.unlink(missing_ok=True)

    async def run(self):
        warned = False
        while True:
            # The first write follows startup; a failed TCP bind must not erase
            # the report of an already running server on the same port.
            await asyncio.sleep(self.interval)
            payload = {"instance": self.instance, "pid": os.getpid(), "updatedAt": time.time(),
                       **self.presence.inspect_clients()}
            write = asyncio.create_task(asyncio.to_thread(self.write, payload))
            try:
                # Finish the atomic write before cleanup, including cancellation.
                await asyncio.shield(write)
                warned = False
            except asyncio.CancelledError:
                await asyncio.gather(write, return_exceptions=True)
                raise
            except OSError as error:
                if not warned:
                    logging.getLogger(__name__).warning("Cannot write private session report: %s", error)
                    warned = True

    async def watch(self, app):
        task = asyncio.create_task(self.run())
        try:
            yield
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            try:
                if json.loads(self.path.read_text())["instance"] == self.instance:
                    self.path.unlink()
            except (OSError, ValueError, KeyError):
                pass


def read_report(path):
    try:
        report = json.loads(Path(path).read_text())
        age = time.time() - report["updatedAt"]
        if not -5 <= age <= 15:
            raise ValueError("The session report is stale; check that the server is running.")
        try:
            os.kill(report["pid"], 0)
        except ProcessLookupError:
            raise ValueError("The server that wrote this report is no longer running.") from None
        except PermissionError:
            pass  # A different OS user can still inspect a file they may read.
        return report
    except FileNotFoundError:
        raise ValueError("No session report yet. Check the server/path and wait two seconds after startup.") from None


def utc(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC") if timestamp else "not reported"


def format_report(report, playing_only=False):
    counts = report["counts"]
    lines = [f'{counts["playing"]} in game / {counts["lan"]} over LAN / {counts["online"]} on site',
             f'Snapshot: {utc(report["updatedAt"])}']
    sessions = [session for session in report["sessions"] if not playing_only or session["playing"]]
    for session in sessions:
        state = "in game" if session["playing"] else "on site"
        if session["lan"]:
            state += ", LAN connected"
        lines += ["", f'Page #{session["id"]}: {state}', f'  IP: {session["ip"] or "unknown"}']
        if session["peerIp"] != session["ip"]:
            lines.append(f'  Proxy peer: {session["peerIp"] or "unknown"}')
        lines.append(f'  Connected: {utc(session["connectedAt"])}')
        if session["playing"]:
            lines.append(f'  Game reported since: {utc(session["playingSince"])}')
        lines.append(f'  Last state report: {utc(session["lastReportAt"])}')
        # The User-Agent is untrusted text: quote/escape terminal control codes.
        lines.append(f'  Browser: {json.dumps(session["userAgent"], ensure_ascii=True)}')
    if not sessions:
        lines.append("No matching active pages.")
    lines += ["", "In game includes loading, cinematics and menus; it is reported by the page.",
              "IP is the address seen by the server; a shared network, VPN or CDN may hide the device's IP."]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080, help="Server port, used to locate its report")
    parser.add_argument("--path", type=Path, help="Custom --presence-report path from server.app")
    parser.add_argument("--playing", action="store_true", help="Only show pages counted as in game")
    parser.add_argument("--json", action="store_true", help="Print the complete private report as JSON")
    args = parser.parse_args()
    try:
        report = read_report(args.path or default_report_path(args.port))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"{error}\n")
    if args.json:
        if args.playing:
            report["sessions"] = [session for session in report["sessions"] if session["playing"]]
        print(json.dumps(report, indent=2))
    else:
        print(format_report(report, args.playing))


if __name__ == "__main__":
    main()
