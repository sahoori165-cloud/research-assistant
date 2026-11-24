"""Hold every runtime setting; application code reads values only from here."""

import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]


def _str(name, fallback):
    return os.getenv(name, fallback)


def _int(name, fallback):
    return int(os.getenv(name, str(fallback)))


def _float(name, fallback):
    return float(os.getenv(name, str(fallback)))


def _bool(name, fallback):
    return os.getenv(name, str(fallback)).strip().lower() in ("true", "1", "yes")


def _path(name, fallback):
    value = Path(os.getenv(name, fallback))
    return value if value.is_absolute() else ROOT / value


class BaseConfig:
    def __init__(self):
        self.app_env = _str("APP_ENV", "development")

        self.openalex_url = _str("OPENALEX_URL", "https://api.openalex.org/works")
        self.openalex_api_key = _str("OPENALEX_API_KEY", "")
        self.openalex_contact_email = _str("OPENALEX_CONTACT_EMAIL", "")
        self.openalex_timeout = _int("OPENALEX_TIMEOUT_SECONDS", 20)
        self.openalex_retries = _int("OPENALEX_MAX_RETRIES", 3)
        self.openalex_page_size = _int("OPENALEX_PAGE_SIZE", 100)
        self.openalex_max_results = _int("OPENALEX_MAX_RESULTS", 400)
        self.openalex_use_cache = _bool("OPENALEX_USE_CACHE", True)

        self.dedup_title_threshold = _float("DEDUP_TITLE_THRESHOLD", 0.94)
        self.dedup_preprint_threshold = _float("DEDUP_PREPRINT_THRESHOLD", 0.86)

        self.rerank_model = _str("RERANK_MODEL", "Qwen/Qwen3-Reranker-0.6B")
        self.rerank_revision = _str("RERANK_REVISION", "e61197ed45024b0ed8a2d74b80b4d909f1255473")
        self.rerank_prompt = _str("RERANK_PROMPT", "rerank_v3.md")
        self.rerank_batch_size = _int("RERANK_BATCH_SIZE", 16)
        self.rerank_batch_tokens = _int("RERANK_BATCH_TOKENS", 8192)
        self.rerank_max_tokens = _int("RERANK_MAX_TOKENS", 1024)
        self.rerank_candidates = _int("RERANK_CANDIDATES", 150)
        self.top_k = _int("TOP_K", 50)

        self.crossref_url = _str("CROSSREF_URL", "https://api.crossref.org/works")
        self.datacite_url = _str("DATACITE_URL", "https://api.datacite.org/dois")
        self.crossref_contact_email = _str("CROSSREF_CONTACT_EMAIL", "")
        self.crossref_timeout = _int("CROSSREF_TIMEOUT", 15)
        self.crossref_retries = _int("CROSSREF_RETRIES", 3)
        self.crossref_workers = _int("CROSSREF_WORKERS", 8)
        self.crossref_request_delay = _float("CROSSREF_REQUEST_DELAY_SECONDS", 0.6)
        self.retraction_watch_csv = _path("RETRACTION_WATCH_CSV", "data/raw/retraction_watch.csv")
        self.retraction_watch_url = _str(
            "RETRACTION_WATCH_URL",
            "https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv?ref_type=heads&inline=false",
        )

        self.embedding_model = _str("EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-0.6B")
        self.embedding_revision = _str("EMBEDDING_REVISION", "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3")
        self.embedding_batch_size = _int("EMBEDDING_BATCH_SIZE", 16)
        self.cluster_search_min = _int("CLUSTER_SEARCH_MIN_K", 3)
        self.cluster_search_max = _int("CLUSTER_SEARCH_MAX_K", 10)
        self.cluster_min = _int("CLUSTER_MIN_K", 4)
        self.cluster_max = _int("CLUSTER_MAX_K", 8)
        self.cluster_n_init = _int("CLUSTER_N_INIT", 10)
        self.trend_years = _int("TREND_YEARS", 10)
        self.incomplete_years = _int("INCOMPLETE_YEARS", 2)

        self.ollama_model = _str("OLLAMA_MODEL", "qwen3.5:9b")
        self.ollama_digest = _str("OLLAMA_DIGEST", "56671c2ab9385f9cfcb404638e32cd62d88e3501d44822208363c010179a3c90")
        self.ollama_url = _str("OLLAMA_URL", "http://127.0.0.1:11434/api/chat")
        self.ollama_timeout = _int("OLLAMA_TIMEOUT", 180)
        self.ollama_retries = _int("OLLAMA_RETRIES", 2)
        self.ollama_verify_timeout = _int("OLLAMA_VERIFY_TIMEOUT", 10)
        self.synthesis_prompt = _str("SYNTHESIS_PROMPT", "synthesis_v3.md")
        self.synthesis_max_sources = _int("SYNTHESIS_MAX_SOURCES", 12)
        self.synthesis_abstract_chars = _int("SYNTHESIS_ABSTRACT_CHARS", 3500)

        self.seed = _int("SEED", 42)
        self.temperature = _float("TEMPERATURE", 0)
        self.model_fallback = _bool("ALLOW_MODEL_FALLBACK", False)

        self.app_host = _str("APP_HOST", "127.0.0.1")
        self.app_port = _int("APP_PORT", 5000)
        self.secret_key = _str("WEB_SECRET_KEY", "")
        self.auth_required = _bool("AUTH_REQUIRED", True)
        self.users_file = _path("USERS_FILE", "instance/users.json")
        self.session_timeout_minutes = _int("SESSION_TIMEOUT_MINUTES", 10)
        self.session_cookie_secure = _bool("SESSION_COOKIE_SECURE", False)
        self.login_max_failures = _int("LOGIN_MAX_FAILURES", 5)
        self.login_lockout_seconds = _int("LOGIN_LOCKOUT_SECONDS", 300)
        self.max_concurrent_jobs = _int("MAX_CONCURRENT_JOBS", 1)
        self.job_retention_minutes = _int("JOB_RETENTION_MINUTES", 120)

        self.log_level = _str("LOG_LEVEL", "INFO")
        self.log_file = _path("LOG_FILE", "data/processed/application.log")

        self.models_lock = ROOT / "models.lock"
        self.data_cache = ROOT / "data/cache"
        self.processed_dir = ROOT / "data/processed"
        self.evaluation_cache = ROOT / "evaluation/cache"


PLACEHOLDER_SECRET_KEYS = {"", "CHANGE_ME_FOR_DEPLOYMENT", "development-only-secret"}


def _local_secret_key():
    """Return a random key kept in instance/secret_key, creating it on first use.

    A publicly known key would let anyone forge a session cookie, so the
    placeholder from .env.example is never used to sign sessions.
    """
    key_file = ROOT / "instance" / "secret_key"
    if key_file.exists():
        key = key_file.read_text(encoding="utf-8").strip()
        if key:
            return key
    key = secrets.token_hex(32)
    key_file.parent.mkdir(parents=True, exist_ok=True)
    key_file.write_text(key, encoding="utf-8")
    return key


class DevelopmentConfig(BaseConfig):
    def __init__(self):
        super().__init__()
        if self.secret_key in PLACEHOLDER_SECRET_KEYS:
            self.secret_key = _local_secret_key()


class ProductionConfig(BaseConfig):
    def __init__(self):
        super().__init__()
        if self.secret_key in PLACEHOLDER_SECRET_KEYS:
            raise ValueError("WEB_SECRET_KEY must be set for production")
        if not self.openalex_api_key or self.openalex_api_key == "YOUR_OPENALEX_API_KEY":
            raise ValueError("OPENALEX_API_KEY must be set for production")
        if self.model_fallback:
            raise ValueError("Model fallback is not permitted in production")
        if not self.auth_required:
            raise ValueError("AUTH_REQUIRED must stay true in production")


class TestingConfig(BaseConfig):
    __test__ = False

    def __init__(self):
        super().__init__()
        self.secret_key = self.secret_key or "testing-secret"
        self.openalex_use_cache = False


CONFIGS = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
    "testing": TestingConfig,
    "default": DevelopmentConfig,
}


def get_config():
    load_dotenv(ROOT / ".env", override=False)
    environment = os.getenv("APP_ENV", "default").strip().lower()
    return CONFIGS.get(environment, CONFIGS["default"])()
