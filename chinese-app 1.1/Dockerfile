FROM python:3.13-slim

WORKDIR /app

COPY build.py server.py ./
COPY src ./src

RUN python3 build.py && mkdir -p /app/data

ENV HOST=0.0.0.0
ENV PORT=8080
ENV DB_PATH=/app/data/app.db

EXPOSE 8080

CMD ["python3", "-u", "server.py"]
