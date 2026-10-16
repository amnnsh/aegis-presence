FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000 DB_PATH=/data/aegis.db
WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
RUN useradd --system --uid 10001 aegis && mkdir -p /data && chown aegis /data
USER aegis

# One worker only: sqlite and the in-memory SSE bus / rate limiter are per-process.
# --forwarded-allow-ips=* trusts the platform proxy's X-Forwarded-For; do not expose this container directly.
CMD ["sh", "-c", "exec uvicorn app.main:create_app --factory --host 0.0.0.0 --port ${PORT} --workers 1 --proxy-headers --forwarded-allow-ips='*'"]
