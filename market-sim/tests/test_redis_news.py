import json
import os
import socket
import threading

import pytest

from ticker_sim.redis_news import CHANNEL, RedisNews, encode


def test_encodes_resp_arrays():
    assert encode("PUBLISH", "c", "hé") == b"*3\r\n$7\r\nPUBLISH\r\n$1\r\nc\r\n$3\r\nh\xc3\xa9\r\n"


def test_rejects_other_urls():
    with pytest.raises(ValueError):
        RedisNews("http://localhost:6379")
    with pytest.raises(ValueError):
        RedisNews("rediss://localhost:6379")


class FakeRedis:
    """Accepts connections, records each command, replies like PUBLISH does."""

    def __init__(self) -> None:
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen()
        self.port = self.srv.getsockname()[1]
        self.commands: list[bytes] = []
        self.connections = 0
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self) -> None:
        while True:
            try:
                conn, _ = self.srv.accept()
            except OSError:
                return
            self.connections += 1
            data = conn.recv(65536)
            self.commands.append(data)
            if data.startswith(b"*2\r\n$4\r\nAUTH") or data.startswith(b"*3\r\n$4\r\nAUTH"):
                conn.sendall(b"+OK\r\n")
                self.commands.append(conn.recv(65536))
            conn.sendall(b":1\r\n")
            conn.close()  # forces the client to reconnect for the next headline


def test_publishes_and_reconnects_after_the_server_drops_it():
    fake = FakeRedis()
    pub = RedisNews(f"redis://:secret@127.0.0.1:{fake.port}")
    pub({"headline": "one"})
    pub({"headline": "two"})
    pub.close()
    sent = [c for c in fake.commands if b"PUBLISH" in c]
    assert len(sent) == 2 and fake.connections >= 2
    assert any(c.startswith(b"*2\r\n$4\r\nAUTH\r\n$6\r\nsecret") for c in fake.commands)
    body = json.loads(sent[1].split(b"\r\n")[6])
    assert body["channel"] == "news" and body["data"]["headline"] == "two" and "at" in body["data"]
    assert CHANNEL.encode() in sent[0]


def test_swallows_errors_when_redis_is_down():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()  # nothing listening there now
    RedisNews(f"redis://127.0.0.1:{port}", timeout=0.2)({"headline": "lost"})


@pytest.mark.skipif(not os.environ.get("REDIS_URL"), reason="needs a real Redis")
def test_real_redis_subscriber_gets_the_headline():
    url = os.environ["REDIS_URL"]
    pub = RedisNews(url)
    sub = socket.create_connection((pub.host, pub.port), timeout=2)
    sub.sendall(encode("SUBSCRIBE", CHANNEL))
    sub.recv(256)  # subscribe confirmation
    pub({"headline": "real"})
    data = b""
    while b"real" not in data:
        data += sub.recv(4096)
    sub.close()
    pub.close()
