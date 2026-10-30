"""Isolate unit/API tests from the running demonstration broker."""
import pytest

@pytest.fixture(autouse=True)
def isolate_mqtt(monkeypatch):
    monkeypatch.setenv('INSPECTGO_MQTT_ENABLED','false')
