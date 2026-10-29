"""Publish simulated observations; no inspection records or historical S1 replay."""
import argparse
from datetime import datetime, timezone
import json
import logging
import math
from pathlib import Path
import threading
import time

import paho.mqtt.client as mqtt

from backend.configuration import FACILITIES

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OVERRIDES = ROOT / '.runtime/stage01/input-overrides.json'
TOPIC = 'nova/bb02/facility/{facility_id}/status'
LOG = logging.getLogger(__name__)


def build_messages(overrides: dict, at: datetime = None) -> list[dict]:
    if not isinstance(overrides, dict):
        raise ValueError('overrides must be an object keyed by facility_id')
    unknown = overrides.keys() - {f['facility_id'] for f in FACILITIES}
    if unknown:
        raise ValueError(f'unknown facilities: {sorted(map(str, unknown))}')
    at = at if at is not None else datetime.now(timezone.utc)
    if not isinstance(at, datetime) or at.tzinfo is None or at.utcoffset() is None:
        raise ValueError('observation time must include a timezone')
    timestamp = at.astimezone(timezone.utc).isoformat()
    messages = []
    for facility in FACILITIES:
        fid = facility['facility_id']
        override = overrides.get(fid, {})
        if not isinstance(override, dict) or override.keys() - {'availability', 'condition', 'metrics'}:
            raise ValueError(f'{fid}: only availability, condition and metrics may be overridden')
        availability = override.get('availability', 'AVAILABLE')
        condition = override.get('condition', 'NORMAL')
        if availability not in ('AVAILABLE', 'UNAVAILABLE', 'UNKNOWN'):
            raise ValueError(f'{fid}: invalid availability')
        if condition not in ('NORMAL', 'WARNING', 'FAULT'):
            raise ValueError(f'{fid}: invalid condition')
        metrics = override.get('metrics', {'latency_ms': 18})
        if not isinstance(metrics, dict) or set(metrics) != {'latency_ms'}:
            raise ValueError(f'{fid}: metrics must contain only latency_ms')
        latency = metrics['latency_ms']
        try:
            valid_latency = (type(latency) in (int, float) and math.isfinite(latency) and latency >= 0)
        except OverflowError:
            valid_latency = False
        if not valid_latency:
            raise ValueError(f'{fid}: latency_ms must be a finite nonnegative number')
        messages.append({
            'facility_id': fid, 'zone_id': facility['zone_id'], 'observed_at': timestamp,
            'source_type': 'SIMULATED', 'availability': availability, 'condition': condition,
            'metrics': {'latency_ms': latency},
        })
    return messages


def load_messages(path):
    try:
        overrides = json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else {}
        return build_messages(overrides)
    except (OSError, ValueError, RecursionError) as error:
        raise ValueError(f'invalid overrides in {path}: {error}') from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=1883)
    parser.add_argument('--interval', type=float, default=2.0, help='Seconds between batches (default: 2)')
    parser.add_argument('--once', action='store_true', help='Publish one validated batch, then exit')
    parser.add_argument('--overrides', type=Path, default=DEFAULT_OVERRIDES,
                        help='JSON keyed by facility_id; reread before every batch; missing means defaults')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    if not math.isfinite(args.interval) or args.interval <= 0:
        parser.error('--interval must be a finite positive number')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    if args.once:
        try:
            load_messages(args.overrides)
        except ValueError as error:
            LOG.error('%s; no batch published', error)
            return 1
    connected = threading.Event()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, clean_session=True)
    client.max_queued_messages_set(len(FACILITIES))
    client.max_inflight_messages_set(len(FACILITIES))
    client.reconnect_delay_set(min_delay=1, max_delay=10)

    def on_connect(_client, _userdata, _flags, reason_code, _properties):
        if reason_code.is_failure:
            connected.clear()
            LOG.error('MQTT connection rejected: %s', reason_code)
        else:
            connected.set()
            LOG.info('Connected to MQTT %s:%s', args.host, args.port)

    def on_disconnect(_client, _userdata, _flags, reason_code, _properties):
        connected.clear()
        LOG.warning('MQTT disconnected (%s); waiting to reconnect', reason_code)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.connect_async(args.host, args.port, keepalive=15)
    client.loop_start()
    try:
        while True:
            if not connected.wait(timeout=10 if args.once else 1):
                if args.once:
                    LOG.error('MQTT connection timed out; no batch published')
                    return 1
                continue
            started = time.monotonic()
            try:
                messages = load_messages(args.overrides)
                pending = []
                for message in messages:
                    if not connected.is_set():
                        raise RuntimeError('MQTT disconnected during batch')
                    info = client.publish(TOPIC.format(**message),
                                          json.dumps(message, allow_nan=False), qos=1, retain=True)
                    if info.rc != mqtt.MQTT_ERR_SUCCESS:
                        raise RuntimeError(f'MQTT publish failed: {mqtt.error_string(info.rc)}')
                    pending.append(info)
                deadline = time.monotonic() + 5
                for info in pending:
                    info.wait_for_publish(timeout=max(0, deadline - time.monotonic()))
                    if not info.is_published():
                        raise RuntimeError('MQTT acknowledgement timed out')
                LOG.info('Published %s simulated observations at %s', len(messages), messages[0]['observed_at'])
            except (ValueError, RuntimeError) as error:
                LOG.error('%s; batch not confirmed', error)
                if args.once:
                    return 1
            else:
                if args.once:
                    return 0
            time.sleep(max(0, args.interval - (time.monotonic() - started)))
    except KeyboardInterrupt:
        return 0
    finally:
        client.disconnect()
        client.loop_stop()


if __name__ == '__main__':
    raise SystemExit(main())
