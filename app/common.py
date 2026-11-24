"""Share deterministic caching, logging, version checks, and retries."""

import hashlib
import json
import logging
import os
import random
import threading
import time
import uuid
from pathlib import Path

LOGGER = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[1]


class PinnedModelError(RuntimeError):
    """Signal that a pinned model is missing or differs from models.lock; never substitute."""


class ServiceUnavailableError(RuntimeError):
    """Signal that a local model service (Ollama) cannot be reached; earlier stages' results stay valid."""


_SHARED_MODELS = {}
_SHARED_LOCK = threading.Lock()


def shared_model(key, loader):
    """Return the object `loader()` builds for `key`, building it once per process.

    Models are keyed by name and pinned revision, so a changed pin loads a new
    model instead of reusing the old one. Later runs skip the multi-second load.
    """
    with _SHARED_LOCK:
        if key not in _SHARED_MODELS:
            _SHARED_MODELS[key] = loader()
        return _SHARED_MODELS[key]


def configure_logging(config):
    log_file = Path(config.log_file)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=getattr(logging, str(config.log_level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=[logging.FileHandler(log_file, encoding="utf-8"), logging.StreamHandler()],
        force=True,
    )


def set_seeds(config):
    random.seed(config.seed)
    try:
        import numpy as np
        np.random.seed(config.seed)
    except ImportError:
        pass
    try:
        os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
        import torch
        torch.manual_seed(config.seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(config.seed)
        if torch.backends.cudnn.is_available():
            torch.backends.cudnn.deterministic = True
            torch.backends.cudnn.benchmark = False
        torch.use_deterministic_algorithms(True)
    except ImportError:
        pass


def fingerprint(payload):
    text = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class Cache:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def get(self, payload):
        path = self.directory / (fingerprint(payload) + ".json")
        if not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))["response"]

    def put(self, payload, response):
        path = self.directory / (fingerprint(payload) + ".json")
        temporary = path.with_name(f"{path.stem}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(
            json.dumps({"input": payload, "response": response}, ensure_ascii=False, sort_keys=True, indent=2, default=str),
            encoding="utf-8",
        )
        temporary.replace(path)


def read_prompt(name):
    return (ROOT / "prompts" / name).read_text(encoding="utf-8")


def load_lock(path=None):
    lock_path = Path(path) if path else ROOT / "models.lock"
    if not lock_path.is_file():
        raise PinnedModelError(f"models.lock not found at {lock_path}. Model fallback is disabled.")
    entries = {}
    for number, line in enumerate(lock_path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "=" not in line:
            raise PinnedModelError(f"models.lock line {number} is not `name=version`: {line!r}")
        name, version = line.split("=", 1)
        entries[name.strip()] = version.strip()
    return entries


def verify_lock(config, path=None):
    lock = load_lock(path or getattr(config, "models_lock", None))
    expected = {
        config.rerank_model: config.rerank_revision,
        config.embedding_model: config.embedding_revision,
        config.ollama_model: config.ollama_digest,
    }
    if lock != expected:
        differences = [
            f"{name}: models.lock={lock.get(name, '<missing>')} configured={expected.get(name, '<missing>')}"
            for name in sorted(set(lock) | set(expected))
            if lock.get(name) != expected.get(name)
        ]
        raise PinnedModelError(
            "Configured model versions differ from models.lock: " + "; ".join(differences)
            + ". Update .env or models.lock deliberately, then run `python setup.py`."
            " Fallback is disabled because results from a different model are not comparable."
        )
    if config.model_fallback:
        raise PinnedModelError("ALLOW_MODEL_FALLBACK must be false for reproducible runs")
    return lock


def request_with_retry(session, method, url, timeout, retries, **kwargs):
    import requests
    for attempt in range(retries + 1):
        try:
            response = session.request(method, url, timeout=timeout, **kwargs)
            if response.status_code in (429, 500, 502, 503, 504) and attempt < retries:
                LOGGER.warning("Retry %s for HTTP %s %s", attempt + 1, response.status_code, url.split("?")[0])
                time.sleep(2 ** attempt)
                continue
            return response
        except requests.RequestException as exc:
            if attempt >= retries:
                raise
            LOGGER.warning("Retry %s after network exception: %s", attempt + 1, exc.__class__.__name__)
            time.sleep(2 ** attempt)
    raise RuntimeError("Unexpected retry exhaustion")


def hf_snapshot(name, revision):
    from huggingface_hub import snapshot_download
    try:
        return snapshot_download(name, revision=revision, local_files_only=True)
    except Exception as exc:
        raise PinnedModelError(
            f"Pinned model {name}@{revision} is not installed. Install it with `python setup.py`"
            f" (it calls snapshot_download('{name}', revision='{revision}')). Fallback is disabled"
            f" because results from a different model are not comparable. Detail: {exc}"
        ) from exc


def verify_ollama(config):
    import requests
    root = config.ollama_url.rsplit("/api/", 1)[0]
    try:
        response = requests.get(root + "/api/tags", timeout=config.ollama_verify_timeout)
        response.raise_for_status()
        installed = {
            item.get("name"): item.get("digest", "").removeprefix("sha256:")
            for item in response.json().get("models", [])
        }
    except Exception as exc:
        raise ServiceUnavailableError(f"Ollama unavailable at {root}: {exc}. Start Ollama (`ollama serve`) and retry.") from exc
    if config.ollama_model not in installed:
        raise PinnedModelError(
            f"Pinned model {config.ollama_model} is missing. Installed models: {sorted(installed) or 'none'}."
            f" Install it with `ollama pull {config.ollama_model}`. Fallback is disabled because results"
            " from a different model are not comparable."
        )
    actual = installed[config.ollama_model]
    if actual != config.ollama_digest:
        raise PinnedModelError(
            f"Pinned model {config.ollama_model} digest mismatch. Expected {config.ollama_digest}, installed {actual}."
            " The tag was updated; re-pin deliberately in models.lock and .env. Fallback is disabled."
        )
    return actual
