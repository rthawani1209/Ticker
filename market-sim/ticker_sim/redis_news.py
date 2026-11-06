"""Sends headlines to the backend's market-data channel in Redis, so every gateway
pushes them to clients subscribed to "news". Plain RESP over a socket: one PUBLISH
a minute or so doesn't justify a Redis client dependency."""

from __future__ import annotations

import json
import logging
import socket
import time
from urllib.parse import urlparse

log = logging.getLogger(__name__)

CHANNEL = "ticker:md"  # must match FANOUT_CHANNEL in backend/src/ws/fanout.ts


def encode(*parts: str) -> bytes:
    out = [f"*{len(parts)}\r\n".encode()]
    for p in parts:
        b = p.encode()
        out.append(b"$%d\r\n%s\r\n" % (len(b), b))
    return b"".join(out)


class RedisNews:
    def __init__(self, url: str, timeout: float = 1.0) -> None:
        u = urlparse(url)
        if u.scheme not in ("redis", "rediss") or not u.hostname:
            raise ValueError(f"not a redis:// url: {url}")
        if u.scheme == "rediss":
            raise ValueError("TLS (rediss://) isn't supported; use the private network URL")
        self.host, self.port = u.hostname, u.port or 6379
        self.password = u.password
        self.username = u.username or None
        self.timeout = timeout
        self.sock: socket.socket | None = None

    def _connect(self) -> socket.socket:
        s = socket.create_connection((self.host, self.port), timeout=self.timeout)
        if self.password:
            args = ["AUTH", self.username, self.password] if self.username else ["AUTH", self.password]
            s.sendall(encode(*args))
            reply = s.recv(256)
            if not reply.startswith(b"+OK"):
                s.close()
                raise ConnectionError(f"redis auth failed: {reply!r}")
        return s

    def __call__(self, headline: dict) -> None:
        """Publishes one headline. Never raises: news is best effort and the sim keeps going."""
        msg = json.dumps({"channel": "news", "data": {**headline, "at": int(time.time() * 1000)}})
        for attempt in range(2):  # one reconnect if the old connection went stale
            try:
                if self.sock is None:
                    self.sock = self._connect()
                self.sock.sendall(encode("PUBLISH", CHANNEL, msg))
                reply = self.sock.recv(64)
                if not reply.startswith(b":"):
                    raise ConnectionError(f"unexpected reply {reply!r}")
                return
            except OSError as err:
                self.close()
                if attempt:
                    log.warning("couldn't publish news to redis: %s", err)

    def close(self) -> None:
        if self.sock is not None:
            self.sock.close()
            self.sock = None
