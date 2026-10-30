#!/bin/bash
set -Eeuo pipefail
cd /app
pids=()
cleanup() {
  trap - EXIT
  if (("${#pids[@]}")); then
    kill -TERM "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
/opt/broker-venv/bin/python -B -m simulators.broker --port 1883 &
pids+=("$!")
/opt/app-venv/bin/python -B -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --workers 1 &
pids+=("$!")
/opt/app-venv/bin/python -B -m simulators.facility_status --host 127.0.0.1 --port 1883 &
pids+=("$!")
set +e
wait -n "${pids[@]}"
result=$?
if [ "$result" -eq 0 ]; then result=1; fi
exit "$result"
