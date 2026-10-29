"""Loopback-only MQTT broker for the stage 01 teaching environment."""
import argparse
import asyncio
import logging

from amqtt.broker import Broker


async def serve(port):
    broker = Broker({
        'listeners': {'default': {'type': 'tcp', 'bind': f'127.0.0.1:{port}',
                                  'max_connections': 16}},
        'session_expiry_interval': 60,
        'plugins': {'amqtt.plugins.authentication.AnonymousAuthPlugin': {
            'allow_anonymous': True}},
    })
    await broker.start()
    logging.info('Teaching MQTT broker listening on 127.0.0.1:%s', port)
    try:
        await asyncio.Event().wait()
    finally:
        await broker.shutdown()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=1883)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('--port must be between 1024 and 65535')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    try:
        asyncio.run(serve(args.port))
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
