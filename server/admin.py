"""Authenticated, owner-only session inspection and targeted game shutdown."""
from __future__ import annotations

import asyncio
from collections import deque
import hashlib
import hmac
from pathlib import Path
import secrets
import time
from urllib.parse import urlsplit

from aiohttp import web

from .admin_auth import parse_hash, verify_password
from .geoip import behind_proxy, connection_address, peer_address

COOKIE = "w3ft_admin"
COOKIE_PATH = "/api/admin"
SESSION_TTL = 8 * 3600
PRIVATE_HEADERS = {"Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
                   "Pragma": "no-cache"}


def is_https(request):
    return request.secure or (behind_proxy(peer_address(request))
                              and request.headers.get("X-Forwarded-Proto") == "https")


class Admin:
    def __init__(self, presence, encoded_password, web_dir):
        self.presence = presence
        self.password = encoded_password
        if encoded_password:
            parse_hash(encoded_password)
        self.web_dir = Path(web_dir)
        self.sessions = {}
        self.attempts = {}
        self.global_attempts = deque()
        self.verifying = False

    @web.middleware
    async def guard(self, request, handler):
        if request.path not in ("/admin", "/admin/", "/admin.html") and not request.path.startswith("/api/admin/"):
            return await handler(request)
        try:
            if not self.password:
                raise web.HTTPNotFound()
            # HTTP is only useful for local development / an SSH tunnel.
            peer = peer_address(request)
            if not is_https(request) and not (peer is not None and peer.is_loopback
                    and request.url.host in ("localhost", "127.0.0.1", "::1")):
                raise web.HTTPForbidden(text="Admin access requires HTTPS")
            origin = request.headers.get("Origin")
            expected_scheme = "https" if is_https(request) else "http"
            if origin:
                parsed = urlsplit(origin)
                if parsed.scheme != expected_scheme or parsed.netloc != request.host:
                    raise web.HTTPForbidden(text="Origin must match this server")
            if request.headers.get("Sec-Fetch-Site") == "cross-site":
                raise web.HTTPForbidden(text="Cross-site admin requests are not allowed")
            response = await handler(request)
        except web.HTTPException as error:
            error.headers.update(PRIVATE_HEADERS)
            raise
        response.headers.update(PRIVATE_HEADERS)
        return response

    async def page(self, request):
        return web.FileResponse(self.web_dir / "admin.html")

    async def body(self, request):
        if request.content_type != "application/json":
            raise web.HTTPUnsupportedMediaType(text="Expected application/json")
        try:
            async with asyncio.timeout(5):
                data = await request.clone(client_max_size=4096).json()
        except (ValueError, UnicodeError):
            raise web.HTTPBadRequest(text="Invalid JSON") from None
        except TimeoutError:
            raise web.HTTPRequestTimeout() from None
        if not isinstance(data, dict):
            raise web.HTTPBadRequest(text="Expected a JSON object")
        return data

    def session(self, request, *, mutation=False):
        now = time.monotonic()
        self.sessions = {key: value for key, value in self.sessions.items() if value["expires"] > now}
        token = request.cookies.get(COOKIE, "")
        key = hashlib.sha256(token.encode()).hexdigest() if len(token) <= 128 else ""
        value = self.sessions.get(key)
        if value is None:
            raise web.HTTPUnauthorized(text="Sign in to continue")
        if mutation and not hmac.compare_digest(request.headers.get("X-CSRF-Token", "").encode(), value["csrf"].encode()):
            raise web.HTTPForbidden(text="Invalid CSRF token")
        return key, value

    async def login(self, request):
        # A custom header + JSON stops cross-origin form submissions, including
        # login CSRF. No CORS permissions are granted by this application.
        if request.headers.get("X-W3FT-Admin") != "1":
            raise web.HTTPForbidden(text="Expected an admin request")
        data = await self.body(request)
        password = data.get("password")
        try:
            valid_length = isinstance(password, str) and 1 <= len(password.encode("utf-8")) <= 1024
        except UnicodeError:
            valid_length = False
        if not valid_length:
            raise web.HTTPBadRequest(text="Invalid password length")
        now = time.monotonic()
        self.attempts = {key: [t for t in times if now - t < 60] for key, times in self.attempts.items()
                         if times and now - times[-1] < 60}
        while self.global_attempts and now - self.global_attempts[0] >= 60:
            self.global_attempts.popleft()
        address = str(connection_address(request))
        attempts = self.attempts.get(address, [])
        if len(attempts) >= 5 or len(self.global_attempts) >= 30 or self.verifying:
            raise web.HTTPTooManyRequests(text="Too many login attempts; try again in a minute",
                                          headers={"Retry-After": "60"})
        # Reserve before awaiting the expensive check. At most one password
        # hash runs at a time; rejected requests do not queue more hash work.
        self.attempts[address] = [*attempts, now]
        self.global_attempts.append(now)
        self.verifying = True
        check = asyncio.create_task(asyncio.to_thread(verify_password, password, self.password))
        try:
            valid = await asyncio.shield(check)
        finally:
            # Cancellation must not allow a second expensive check to start
            # while the first one is still running in its worker thread.
            await asyncio.gather(check, return_exceptions=True)
            self.verifying = False
        if not valid:
            raise web.HTTPUnauthorized(text="Incorrect password")
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.sessions = {key: value for key, value in self.sessions.items() if value["expires"] > now}
        old = request.cookies.get(COOKIE, "")
        self.sessions.pop(hashlib.sha256(old.encode()).hexdigest(), None)
        while len(self.sessions) >= 8:
            self.sessions.pop(next(iter(self.sessions)))
        self.sessions[hashlib.sha256(token.encode()).hexdigest()] = {"csrf": csrf, "expires": now + SESSION_TTL}
        response = web.json_response({"csrf": csrf})
        response.set_cookie(COOKIE, token, httponly=True, secure=is_https(request), samesite="Strict",
                            path=COOKIE_PATH, max_age=SESSION_TTL)
        return response

    async def status(self, request):
        _, session = self.session(request)
        return web.json_response({"csrf": session["csrf"]})

    async def listing(self, request):
        self.session(request)
        return web.json_response({"generation": self.presence.generation, **self.presence.inspect_clients()})

    async def kick(self, request):
        self.session(request, mutation=True)
        data = await self.body(request)
        if data.get("generation") != self.presence.generation:
            raise web.HTTPConflict(text="Server restarted; refresh the list before choosing a session")
        identifier = data.get("id")
        if type(identifier) is not int or identifier < 1:
            raise web.HTTPBadRequest(text="Invalid page ID")
        result = await self.presence.kick(identifier)
        if result == "missing":
            raise web.HTTPNotFound(text="This page is already disconnected")
        return web.json_response({"disconnected": True, "stopRequested": result == "kicked"})

    async def logout(self, request):
        key, _ = self.session(request, mutation=True)
        self.sessions.pop(key, None)
        response = web.json_response({"loggedOut": True})
        response.del_cookie(COOKIE, path=COOKIE_PATH, secure=is_https(request), httponly=True, samesite="Strict")
        return response

    def install(self, app):
        app.middlewares.append(self.guard)
        app.router.add_get("/admin", self.page)
        app.router.add_get("/admin/", self.page)
        app.router.add_get("/admin.html", self.page)
        app.router.add_post("/api/admin/login", self.login)
        app.router.add_get("/api/admin/session", self.status)
        app.router.add_get("/api/admin/sessions", self.listing)
        app.router.add_post("/api/admin/kick", self.kick)
        app.router.add_post("/api/admin/logout", self.logout)
