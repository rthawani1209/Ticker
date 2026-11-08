# The matching engine. Build: docker build -t ticker-engine engine
FROM debian:trixie AS build
RUN apt-get update && apt-get install -y --no-install-recommends g++ cmake make \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY CMakeLists.txt ./
COPY include include
COPY src src
COPY tools tools
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DTICKER_BUILD_TESTS=OFF -DTICKER_BUILD_BENCH=OFF \
    && cmake --build build -j"$(nproc)" --target ticker-engine

FROM debian:trixie-slim
COPY --from=build /src/build/ticker-engine /usr/local/bin/ticker-engine
# The journal is how the books survive a restart; mount a volume here.
RUN mkdir /data && chown nobody /data
VOLUME /data
USER nobody
EXPOSE 9100
# TICKER_TOKEN (the shared secret for the gateway and the simulator) comes from the environment.
# "::" takes IPv6 and IPv4; Railway's private network is IPv6.
CMD ["ticker-engine", "--host", "::", "--port", "9100", "--journal-dir", "/data"]
