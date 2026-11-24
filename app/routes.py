"""Expose the same research pipeline through HTML and JSON routes."""

import json
import threading
import time
import uuid

from flask import Blueprint, Response, current_app, jsonify, render_template, request

from app.auth import current_user, login_required
from app.pipeline.runner import execute

bp = Blueprint("main", __name__)
JOBS = {}
LOCK = threading.Lock()
RUN_SLOTS = {}


def _slots(config):
    with LOCK:
        if "slots" not in RUN_SLOTS:
            RUN_SLOTS["slots"] = threading.BoundedSemaphore(max(1, config.max_concurrent_jobs))
        return RUN_SLOTS["slots"]


def _forget_old_jobs(config):
    cutoff = time.time() - config.job_retention_minutes * 60
    for job_id in [key for key, job in JOBS.items()
                   if job.get("payload") is not None and (job.get("finished") or 0) < cutoff]:
        del JOBS[job_id]


def _envelope_status(payload):
    if payload["stage"] != "failed":
        return 200
    stages = {error.get("stage") for error in payload.get("errors", [])}
    if "input" in stages:
        return 400
    if "models" in stages:
        return 503
    return 502 if "retrieval" in stages else 500


def _question():
    body = request.get_json(silent=True)
    question = body.get("question", "") if isinstance(body, dict) else ""
    return question if isinstance(question, str) else ""


def _owner():
    user = current_user()
    return user["username"].lower() if user else None


def _visible_job(job_id):
    job = JOBS.get(job_id)
    if job is None or job.get("owner") != _owner():
        return None
    return job


def worker(job_id, question, config):
    def progress(stage, detail):
        with LOCK:
            JOBS[job_id].update({"stage": stage, "progress": detail})
    with _slots(config):
        payload = execute(question, config, progress)
    with LOCK:
        JOBS[job_id].update({"stage": payload["stage"], "progress": "Finished", "payload": payload,
                             "finished": time.time()})


@bp.get("/")
def home():
    return render_template("index.html", session_timeout=current_app.config["RESEARCH_CONFIG"].session_timeout_minutes)


@bp.post("/api/search")
@login_required
def api_search():
    question = _question()
    if not question.strip():
        return jsonify({"results": [], "errors": [{"stage": "input", "message": "A research question is required"}]}), 400
    config = current_app.config["RESEARCH_CONFIG"]
    slots = _slots(config)
    if not slots.acquire(blocking=False):
        return jsonify({"results": [], "errors": [{"stage": "job", "message":
                        "The server is busy with another search; try again shortly"}]}), 429
    try:
        payload = execute(question, config)
    finally:
        slots.release()
    return jsonify(payload), _envelope_status(payload)


@bp.post("/api/jobs")
@login_required
def create_job():
    question = _question()
    if not question.strip():
        return jsonify({"results": [], "errors": [{"stage": "input", "message": "A research question is required"}]}), 400
    config = current_app.config["RESEARCH_CONFIG"]
    owner = _owner()
    job_id = uuid.uuid4().hex
    with LOCK:
        _forget_old_jobs(config)
        if any(job.get("owner") == owner and job.get("payload") is None for job in JOBS.values()):
            return jsonify({"results": [], "errors": [{"stage": "job", "message":
                            "You already have a search running; wait for it to finish"}]}), 429
        JOBS[job_id] = {"stage": "queued", "progress": "Queued", "payload": None, "owner": owner, "finished": None}
    thread = threading.Thread(target=worker, args=(job_id, question, config), daemon=True)
    thread.start()
    return jsonify({"job_id": job_id, "results": [], "errors": []}), 202


@bp.get("/api/jobs/<job_id>")
@login_required
def job_status(job_id):
    with LOCK:
        job = _visible_job(job_id)
        if job is None:
            return jsonify({"results": [], "errors": [{"stage": "job", "message": "Unknown job"}]}), 404
        payload = job["payload"] or {}
        public = {key: value for key, value in job.items() if key != "owner"}
        return jsonify({"job_id": job_id, **public, "results": payload.get("results", []), "errors": payload.get("errors", [])})


def _download(job_id, field, mimetype, filename, render):
    with LOCK:
        job = _visible_job(job_id)
        if not job or not job["payload"]:
            return jsonify({"results": [], "errors": [{"stage": "job", "message": "Job not ready"}]}), 404
        content = render(job["payload"].get(field))
    return Response(content, mimetype=mimetype, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@bp.get("/api/jobs/<job_id>/bibtex")
@login_required
def download_bibtex(job_id):
    return _download(job_id, "bibtex", "application/x-bibtex; charset=utf-8", "papers.bib", lambda value: value or "")


@bp.get("/api/jobs/<job_id>/csl")
@login_required
def download_csl(job_id):
    return _download(job_id, "csl_json", "application/json", "papers.csl.json",
                     lambda value: json.dumps(value or [], ensure_ascii=False, indent=2))
