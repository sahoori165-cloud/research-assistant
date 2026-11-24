"""Create the Flask application without eager model loading."""

from datetime import timedelta

from config.config import get_config


def create_app(config=None):
    from flask import Flask
    configuration = config or get_config()
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=configuration.secret_key,
        RESEARCH_CONFIG=configuration,
        PERMANENT_SESSION_LIFETIME=timedelta(minutes=configuration.session_timeout_minutes),
        SESSION_REFRESH_EACH_REQUEST=True,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=configuration.session_cookie_secure,
    )
    from app.auth import auth_bp
    from app.routes import bp
    app.register_blueprint(auth_bp)
    app.register_blueprint(bp)

    @app.after_request
    def security_headers(response):
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        return response

    return app
