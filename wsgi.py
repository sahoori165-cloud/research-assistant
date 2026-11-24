"""Production WSGI entry point."""

from app import create_app
from app.common import configure_logging
from config.config import get_config

config = get_config()
configure_logging(config)
application = create_app(config)

if __name__ == "__main__":
    import logging

    from waitress import serve
    logging.getLogger(__name__).info("Serving on http://%s:%s", config.app_host, config.app_port)
    serve(application, host=config.app_host, port=config.app_port, threads=8)
