"""Authenticate users against salted password hashes stored outside version control."""

import json
import threading
import time
from functools import wraps
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

auth_bp = Blueprint("auth", __name__)
MIN_PASSWORD_LENGTH = 10
ROLES = ("Professor", "Postgraduate student", "Researcher")
_FAILURES = {}
_FAILURES_LOCK = threading.Lock()
_DUMMY_HASH = generate_password_hash("timing-equaliser-not-a-password")


def load_users(path):
    path = Path(path)
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8")).get("users", {})


def save_users(path, users):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"users": users}, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    temporary.replace(path)


def set_user(path, username, password, role):
    """Create or update an account with a salted scrypt hash of `password`.

    Args:
        path: Location of the accounts file.
        username: Display name; matching is case-insensitive.
        password: Plain password; only its hash is stored.
        role: One of ROLES.

    Returns:
        The stored record without the hash.
    """
    username = str(username).strip()
    if not username:
        raise ValueError("Username is required")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    if role not in ROLES:
        raise ValueError(f"Role must be one of: {', '.join(ROLES)}")
    users = load_users(path)
    users[username.lower()] = {"username": username, "role": role, "password_hash": generate_password_hash(password)}
    save_users(path, users)
    return {"username": username, "role": role}


def remove_user(path, username):
    users = load_users(path)
    existed = users.pop(str(username).strip().lower(), None) is not None
    if existed:
        save_users(path, users)
    return existed


def authenticate(path, username, password):
    record = load_users(path).get(str(username).strip().lower())
    if record is None:
        check_password_hash(_DUMMY_HASH, password)
        return None
    if not check_password_hash(record["password_hash"], password):
        return None
    return {"username": record["username"], "role": record["role"]}


def _locked(key, config):
    now = time.monotonic()
    with _FAILURES_LOCK:
        recent = [moment for moment in _FAILURES.get(key, []) if now - moment < config.login_lockout_seconds]
        _FAILURES[key] = recent
        return len(recent) >= config.login_max_failures


MAX_TRACKED_USERNAMES = 10_000


def _record_failure(key, config):
    now = time.monotonic()
    with _FAILURES_LOCK:
        if len(_FAILURES) >= MAX_TRACKED_USERNAMES:
            for stale in [name for name, moments in _FAILURES.items()
                          if not moments or now - moments[-1] >= config.login_lockout_seconds]:
                del _FAILURES[stale]
        _FAILURES.setdefault(key, []).append(now)


def _error(stage, message, status):
    return jsonify({"results": [], "errors": [{"stage": stage, "message": message}]}), status


def current_user():
    return session.get("user")


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        config = current_app.config["RESEARCH_CONFIG"]
        if config.auth_required:
            user = current_user()
            if not user or user["username"].lower() not in load_users(config.users_file):
                session.clear()
                return _error("auth", "Sign-in required", 401)
        return view(*args, **kwargs)
    return wrapper


@auth_bp.post("/api/auth/login")
def login():
    config = current_app.config["RESEARCH_CONFIG"]
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        body = {}
    username, password = str(body.get("username", "")), str(body.get("password", ""))
    key = username.strip().lower()
    if not key or not password:
        return _error("auth", "Username and password are required", 400)
    if _locked(key, config):
        return _error("auth", "Too many failed attempts; try again later", 429)
    if not load_users(config.users_file):
        return _error("auth", "No accounts exist yet. Create one with: python manage_users.py add <username>", 503)
    user = authenticate(config.users_file, username, password)
    if user is None:
        _record_failure(key, config)
        return _error("auth", "Incorrect username or password", 401)
    with _FAILURES_LOCK:
        _FAILURES.pop(key, None)
    session.clear()
    session.permanent = True
    session["user"] = user
    return jsonify({**user, "results": [], "errors": []})


@auth_bp.post("/api/auth/logout")
def logout():
    session.clear()
    return jsonify({"results": [], "errors": []})


@auth_bp.get("/api/auth/me")
def me():
    user = current_user()
    if not user:
        return _error("auth", "Not signed in", 401)
    config = current_app.config["RESEARCH_CONFIG"]
    if config.auth_required and user["username"].lower() not in load_users(config.users_file):
        session.clear()
        return _error("auth", "Not signed in", 401)
    return jsonify({**user, "results": [], "errors": []})
