# The simulated market: bots and news. Build: docker build -t ticker-sim market-sim
FROM python:3.12-slim
RUN pip install --no-cache-dir "numpy>=2.0"
WORKDIR /app
COPY ticker_sim ticker_sim
COPY scenarios scenarios
USER nobody
# ENGINE_HOST, TICKER_TOKEN, REDIS_URL and SCENARIO come from the environment.
CMD ["sh", "-c", "exec python -m ticker_sim --host \"${ENGINE_HOST:-engine}\" --port \"${ENGINE_PORT:-9100}\" --scenario \"${SCENARIO:-calm}\""]
