
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install BgUtils PO Token Provider
RUN curl -fsSL https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/2.0.2/bgutil-ytdlp-pot-provider-2.0.2.tgz \
    -o /tmp/bgutil-provider.tgz

COPY main.py .

EXPOSE 8000

CMD ["sh", "-c", "echo 'Provider installation needs to be configured before startup'; uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
