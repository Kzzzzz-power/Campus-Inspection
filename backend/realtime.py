"""Stage 01 MQTT observations: bounded in-memory state, never inspection coverage."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import logging
import math
import threading
import sqlite3
from uuid import uuid4

import paho.mqtt.client as mqtt

if __package__:
    from .configuration import FACILITIES
    from . import evidence
else:
    from configuration import FACILITIES
    import evidence

TOPIC_PREFIX = 'nova/bb02/facility/'
SUBSCRIPTION = TOPIC_PREFIX + '+/status'
LOGGER = logging.getLogger(__name__)


def utcnow():
    return datetime.now(timezone.utc)


def validate_message(topic, payload, received_at):
    if len(payload) > 16384:
        raise ValueError('MQTT payload exceeds 16 KiB')
    def invalid_constant(value):
        raise ValueError('Non-finite JSON number')
    value = json.loads(payload.decode('utf-8'), parse_constant=invalid_constant)
    fields = {'facility_id','zone_id','observed_at','source_type','availability','condition','metrics'}
    if not isinstance(value, dict) or set(value)-{'event_id'} != fields:
        raise ValueError('Observation fields are incomplete or unsupported')
    if 'event_id' in value and (not isinstance(value['event_id'],str) or not 1 <= len(value['event_id']) <= 128 or not value['event_id'].strip()):
        raise ValueError('Invalid event_id')
    catalog = {f['facility_id']: f for f in FACILITIES}
    fid = value['facility_id']
    if not isinstance(fid, str) or fid not in catalog or topic != TOPIC_PREFIX + fid + '/status':
        raise ValueError('Unknown facility or mismatched MQTT topic')
    if value['zone_id'] != catalog[fid]['zone_id']:
        raise ValueError('Facility zone does not match the catalog')
    if value['source_type'] not in ('SIMULATED', 'DEVICE'):
        raise ValueError('Unsupported observation source')
    if value['availability'] not in ('AVAILABLE','UNAVAILABLE','UNKNOWN') or value['condition'] not in ('NORMAL','WARNING','FAULT'):
        raise ValueError('Invalid facility business value')
    observed = datetime.fromisoformat(value['observed_at'].replace('Z','+00:00'))
    if observed.utcoffset() is None or observed > received_at + timedelta(seconds=5):
        raise ValueError('Observation time must include a timezone and cannot be in the future')
    metrics = value['metrics']
    if not isinstance(metrics, dict) or len(metrics) > 20:
        raise ValueError('Invalid metrics object')
    if any(not isinstance(key, str) or not 1 <= len(key) <= 64 or type(number) not in (int,float)
           or not math.isfinite(number) for key, number in metrics.items()):
        raise ValueError('Metrics must contain finite numbers')
    if metrics.get('latency_ms', 0) < 0:
        raise ValueError('Latency cannot be negative')
    return value, observed.astimezone(timezone.utc)


class FacilityFeed:
    def __init__(self, enabled=True, stale_after_seconds=10, store=None):
        self.store = store
        self._storage = {}
        if not 2 <= stale_after_seconds <= 300:
            raise ValueError('Stale threshold must be between 2 and 300 seconds')
        self.stale_after_seconds = stale_after_seconds
        self._lock = threading.RLock()
        self._current = {}
        self._epoch = 0
        self._revision = 0
        self._broker = {'state':'connecting' if enabled else 'disabled', 'reason':''}
        self._diagnostics = {'accepted':0, 'rejected':0, 'duplicates':0, 'out_of_order':0, 'last_error':None}

    def mark_connection(self, state, reason=''):
        with self._lock:
            if state != self._broker['state'] or reason != self._broker['reason']:
                if state == 'connected':
                    self._epoch += 1
                self._broker = {'state':state, 'reason':reason}
                self._revision += 1

    def ingest(self, topic, payload, received_at=None):
        received_at = received_at or utcnow()
        try:
            value, observed = validate_message(topic, payload, received_at)
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError) as error:
            with self._lock:
                self._diagnostics['rejected'] += 1
                self._diagnostics['last_error'] = str(error)
            LOGGER.warning('Rejected facility observation: %s', error)
            return 'rejected'
        value['observed_at'] = observed.isoformat(timespec='microseconds')
        event_id = value.pop('event_id',None)
        derived = event_id is None
        event_id = event_id or 'derived-'+evidence.service.fingerprint(value)
        with self._lock:
            previous = self._current.get(value['facility_id'])
            if previous:
                if observed < previous['observed']:
                    self._diagnostics['out_of_order'] += 1
                    return 'out_of_order'
                if observed == previous['observed'] and value != previous['observation']:
                    self._diagnostics['rejected'] += 1
                    self._diagnostics['last_error'] = 'Conflicting observation at the same observed_at'
                    return 'rejected'
            persisted_result = None
            if self.store:
                try:
                    persisted_result, observation_id = evidence.persist_observation(self.store,value,received_at.isoformat(),event_id,derived)
                    if persisted_result in ('rejected','out_of_order'):
                        self._diagnostics['rejected' if persisted_result=='rejected' else 'out_of_order'] += 1
                        return persisted_result
                    self._storage[value['facility_id']] = {'status':'ok','observation_id':observation_id,'error':None}
                except (sqlite3.Error, OSError) as error:
                    self._storage[value['facility_id']] = {'status':'error','observation_id':None,
                        'error':str(error),'retry':'Resend the same message; no automatic historical freshness restoration'}
                    LOGGER.error('Observation persistence failed: %s',error)
            if previous and observed == previous['observed']:
                previous['epoch'] = self._epoch
                self._diagnostics['duplicates'] += 1
                return 'duplicate'
            self._current[value['facility_id']] = {'observation':value, 'observed':observed,
                                                    'received_at':received_at.isoformat(), 'epoch':self._epoch}
            self._diagnostics['accepted'] += 1
            self._revision += 1
        return 'duplicate' if persisted_result == 'duplicate' else 'accepted'

    def snapshot(self, at=None):
        at = at or utcnow()
        with self._lock:
            points = []
            for facility in FACILITIES:
                current = self._current.get(facility['facility_id'])
                fresh = (current and self._broker['state'] == 'connected' and current['epoch'] == self._epoch
                         and (at - current['observed']).total_seconds() <= self.stale_after_seconds)
                points.append({**facility, 'observation':current['observation'] if current else None,
                               'received_at':current['received_at'] if current else None,
                               'storage':self._storage.get(facility['facility_id'], {'status':'not_attempted'}),
                               'freshness':'fresh' if fresh else 'stale' if current else 'missing'})
            return deepcopy({'type':'facilities_snapshot', 'revision':self._revision, 'as_of':at.isoformat(),
                             'stale_after_seconds':self.stale_after_seconds, 'broker':self._broker,
                             'facilities':points, 'diagnostics':self._diagnostics})


class MqttReceiver:
    def __init__(self, feed, host='127.0.0.1', port=1883):
        if not 1 <= port <= 65535:
            raise ValueError('Invalid MQTT port')
        self.feed, self.host, self.port = feed, host, port
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                                  client_id='inspectgo-api-' + uuid4().hex[:12], protocol=mqtt.MQTTv311)
        self.client.reconnect_delay_set(min_delay=1, max_delay=10)
        self.client.connect_timeout = 3
        self.client.on_connect = self._connect
        self.client.on_subscribe = self._subscribed
        self.client.on_connect_fail = lambda client, data: feed.mark_connection('disconnected', 'Broker connection failed; retrying')
        self.client.on_disconnect = lambda client, data, flags, code, props: feed.mark_connection('disconnected', str(code))
        self.client.on_message = lambda client, data, msg: feed.ingest(msg.topic, msg.payload)

    def _connect(self, client, userdata, flags, reason_code, properties):
        if reason_code.is_failure:
            self.feed.mark_connection('disconnected', str(reason_code))
            return
        self.feed.mark_connection('connecting', 'Awaiting subscription acknowledgement')
        result, _ = client.subscribe(SUBSCRIPTION, qos=1)
        if result != mqtt.MQTT_ERR_SUCCESS:
            self.feed.mark_connection('disconnected', 'Subscribe request failed')

    def _subscribed(self, client, userdata, mid, reason_codes, properties):
        if any(reason.is_failure for reason in reason_codes):
            self.feed.mark_connection('disconnected', 'Broker rejected subscription')
        else:
            self.feed.mark_connection('connected')

    def start(self):
        self.client.connect_async(self.host, self.port, keepalive=5)
        self.client.loop_start()

    def stop(self):
        self.client.disconnect()
        self.client.loop_stop()
