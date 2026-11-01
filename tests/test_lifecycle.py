"""Shutdown must drain maintenance transactions without waiting out the idle interval."""
import asyncio
import sqlite3
import threading

import pytest

from backend import main as api


async def wait_for_thread(event):
    async def wait():
        while not event.is_set():
            await asyncio.sleep(.001)
    await asyncio.wait_for(wait(), timeout=5)


def test_shutdown_waits_for_maintenance_transaction(monkeypatch, tmp_path):
    held, release, closed = (threading.Event() for _ in range(3))
    order = []

    def maintain(store):
        try:
            with store.transaction() as connection:
                connection.execute('SELECT name FROM sqlite_master').fetchall()
                held.set()
                assert release.wait(10), 'Maintenance gate was not released'
        finally:
            order.append('transaction_closed')
            closed.set()

    monkeypatch.delenv('INSPECTGO_MAINTENANCE_FILE', raising=False)
    monkeypatch.setattr(api.review_service, 'maintain', maintain)
    database = tmp_path / 'test.db'
    app = api.create_app(database, tmp_path / 'uploads', False, False)

    async def scenario():
        context = app.router.lifespan_context(app)
        await context.__aenter__()
        shutdown = None
        try:
            await wait_for_thread(held)

            async def exit_lifespan():
                await context.__aexit__(None, None, None)
                order.append('lifespan_exited')

            shutdown = asyncio.create_task(exit_lifespan())
            # The real transaction stays gated while shutdown gets time to run.
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.shield(shutdown), timeout=.25)
            assert not closed.is_set()
            release.set()
            await asyncio.wait_for(asyncio.shield(shutdown), timeout=3)
            assert order == ['transaction_closed', 'lifespan_exited']
            database.unlink()
            assert not database.exists()
        finally:
            release.set()
            if shutdown is None:
                shutdown = asyncio.create_task(context.__aexit__(None, None, None))
            await asyncio.wait_for(asyncio.shield(shutdown), timeout=3)
            await wait_for_thread(closed)

    asyncio.run(scenario())


@pytest.mark.parametrize('maintenance_error', [False, True], ids=['idle', 'expected-error'])
def test_shutdown_interrupts_idle_maintenance_wait(monkeypatch, tmp_path, caplog, maintenance_error):
    maintained = threading.Event()

    def maintain(store):
        with store.transaction() as connection:
            connection.execute('SELECT name FROM sqlite_master').fetchall()
        maintained.set()
        if maintenance_error:
            raise sqlite3.OperationalError('expected maintenance failure')

    monkeypatch.delenv('INSPECTGO_MAINTENANCE_FILE', raising=False)
    monkeypatch.setattr(api.review_service, 'maintain', maintain)
    database = tmp_path / 'test.db'
    app = api.create_app(database, tmp_path / 'uploads', False, False)

    async def scenario():
        async with app.router.lifespan_context(app):
            await wait_for_thread(maintained)
            # Let the completed thread result reach the maintenance idle wait.
            await asyncio.sleep(.02)
        database.unlink()
        assert not database.exists()

    asyncio.run(asyncio.wait_for(scenario(), timeout=3))
    if maintenance_error:
        assert 'Review lifecycle maintenance failed' in caplog.text
