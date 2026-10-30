FROM public.ecr.aws/docker/library/python:3.11.17-slim-bookworm AS dependencies
COPY source/requirements-lock.txt /requirements-app.txt
COPY source/requirements-broker-lock.txt /requirements-broker.txt
COPY wheels/app/ /wheels/app/
COPY wheels/broker/ /wheels/broker/
RUN python -m venv /opt/app-venv \
 && python -m venv /opt/broker-venv \
 && /opt/app-venv/bin/python -m pip install --no-index --no-cache-dir --find-links=/wheels/app -r /requirements-app.txt \
 && /opt/broker-venv/bin/python -m pip install --no-index --no-cache-dir --find-links=/wheels/broker -r /requirements-broker.txt \
 && /opt/app-venv/bin/python -m pip check \
 && /opt/broker-venv/bin/python -m pip check

FROM public.ecr.aws/docker/library/python:3.11.17-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    INSPECTGO_DB=/data/inspectgo.db INSPECTGO_UPLOADS=/data/uploads \
    INSPECTGO_SEED_DEMO=false INSPECTGO_MQTT_ENABLED=true \
    INSPECTGO_MQTT_HOST=127.0.0.1 INSPECTGO_MQTT_PORT=1883
WORKDIR /app
COPY --from=dependencies /opt/app-venv /opt/app-venv
COPY --from=dependencies /opt/broker-venv /opt/broker-venv
COPY source/backend/*.py ./backend/
COPY source/simulators/*.py ./simulators/
COPY source/frontend/ ./frontend/
COPY source/config/ ./config/
COPY source/tests/ ./tests/
COPY source/deploy/ ./deploy/
COPY source/.github/ ./.github/
COPY start.sh /usr/local/bin/campus-start.sh
RUN mkdir /app/.runtime && chown 10001:10001 /app/.runtime
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=5s --timeout=5s --start-period=30s --retries=6 \
  CMD /opt/app-venv/bin/python -c "import json,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3)); assert d['status']=='ok' and d['mqtt']['state']=='connected'"
CMD ["/bin/bash", "/usr/local/bin/campus-start.sh"]
