"""Set the admin password on the VPS: python3 -m server.admin_auth.

Uses only the Python standard library. The password is read from the terminal;
only its salted hash is saved in .env, never the password or a session token.
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets
import tempfile

ENV_KEY = "WC3_ADMIN_PASSWORD_HASH"
ITERATIONS = 600_000


def password_hash(password):
    if not 16 <= len(password) or len(password.encode("utf-8")) > 1024:
        raise ValueError("Use at least 16 characters and at most 1024 UTF-8 bytes.")
    salt = secrets.token_bytes(32)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)
    return f"pbkdf2-sha256:{ITERATIONS}:{salt.hex()}:{digest.hex()}"


def parse_hash(value):
    if not re.fullmatch(r"pbkdf2-sha256:600000:[0-9a-f]{64}:[0-9a-f]{64}", value):
        raise ValueError(f"Invalid {ENV_KEY}; run python3 -m server.admin_auth on the server.")
    _, iterations, salt, digest = value.split(":")
    return int(iterations), bytes.fromhex(salt), bytes.fromhex(digest)


def verify_password(password, encoded):
    iterations, salt, expected = parse_hash(encoded)
    if not isinstance(password, str) or len(password.encode("utf-8")) > 1024:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


def save_env(path, encoded):
    parse_hash(encoded)
    path = Path(path)
    if path.is_symlink():
        raise ValueError("Refusing to replace a symlink; select the actual .env file.")
    old = path.read_text(encoding="utf-8") if path.exists() else ""
    lines = [line for line in old.splitlines()
             if not re.match(rf"\s*(?:export\s+)?{ENV_KEY}\s*=", line)]
    lines.append(f"{ENV_KEY}={encoded}")
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix=".w3ft-admin-",
                                         dir=path.parent, delete=False) as stream:
            name = Path(stream.name)
            stream.write("\n".join(lines) + "\n")
        os.replace(name, path)  # tempfile is mode 0600, including existing .env.
    finally:
        if name is not None:
            name.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    args = parser.parse_args()
    try:
        password = getpass.getpass("New admin password (at least 16 characters): ")
        if password != getpass.getpass("Repeat password: "):
            raise ValueError("Passwords do not match.")
        save_env(args.env_file, password_hash(password))
    except (OSError, ValueError, EOFError) as error:
        parser.exit(1, f"{error}\n")
    print(f"Admin password hash saved in {args.env_file}. Recreate the web container to apply it.")


if __name__ == "__main__":
    main()
