"""Asyncio connection to ticker-engine."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from . import protocol as p

log = logging.getLogger(__name__)

Handler = Callable[[p.Event | p.Stats], None]


class EngineError(Exception):
    pass


class EngineClient:
    """One session with the engine. Messages are queued with send() and flushed
    by the event loop; incoming messages go to `on_message`."""

    def __init__(self, on_message: Handler) -> None:
        self.on_message = on_message
        self.session = 0
        self.symbols = 0
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._task: asyncio.Task | None = None
        self.closed = asyncio.Event()

    async def connect(self, host: str, port: int, *, account: int = 0, flags: int = 0, token: int = 0) -> p.LogonAck:
        self._reader, self._writer = await asyncio.open_connection(host, port)
        self._writer.write(p.logon(account, flags, token))
        await self._writer.drain()

        buf = bytearray()
        while True:
            data = await self._reader.read(4096)
            if not data:
                raise EngineError("engine closed the connection during logon")
            buf += data
            msgs = p.split(buf)
            if msgs:
                break
        first = p.decode(msgs[0])
        if isinstance(first, p.ErrorCode):
            raise EngineError(f"logon refused: {first.name}")
        if not isinstance(first, p.LogonAck):
            raise EngineError(f"expected LogonAck, got {first!r}")
        self.session, self.symbols = first.session, first.symbols

        for m in msgs[1:]:
            self._dispatch(m)
        self._task = asyncio.create_task(self._read_loop(buf))
        return first

    def send(self, msg: bytes) -> None:
        if self._writer is None or self._writer.is_closing():
            raise EngineError("not connected")
        self._writer.write(msg)

    async def drain(self) -> None:
        if self._writer is not None:
            await self._writer.drain()

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._writer is not None:
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except ConnectionError:
                pass

    async def _read_loop(self, buf: bytearray) -> None:
        assert self._reader is not None
        try:
            while data := await self._reader.read(1 << 16):
                buf += data
                for m in p.split(buf):
                    self._dispatch(m)
            log.warning("engine closed the connection")
        except (ConnectionError, p.ProtocolError) as exc:
            log.error("engine connection failed: %s", exc)
        finally:
            self.closed.set()

    def _dispatch(self, raw: bytes) -> None:
        msg = p.decode(raw)
        if isinstance(msg, p.ErrorCode):
            log.error("engine error: %s", msg.name)
            return
        if isinstance(msg, p.LogonAck):
            return
        self.on_message(msg)
