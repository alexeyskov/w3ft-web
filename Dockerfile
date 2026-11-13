FROM python:3.13-slim
WORKDIR /app
RUN pip install --no-cache-dir aiohttp==3.13.2 psutil==7.2.2
COPY server ./server
COPY web ./web
RUN useradd --uid 10001 --create-home wc3 \
    && mkdir -p /app/var/issues /app/var/activity \
    && chown wc3:wc3 /app/var/issues /app/var/activity
USER wc3
EXPOSE 8080
CMD ["python", "-m", "server.app", "--host", "0.0.0.0", "--port", "8080"]
