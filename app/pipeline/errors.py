"""Normalise pipeline error records before they reach the client.

Identical messages from one stage (e.g. the same summarisation failure for several themes)
are merged into a single record that keeps every affected cluster/paper id. Each record keeps
the original `stage` and `message` keys and adds `text`, `type`, `lang`, `count`.
"""

import re

ARABIC = re.compile(r"[؀-ۿ]")


def message_lang(text):
    return "ar" if ARABIC.search(str(text or "")) else "en"


def normalise_errors(errors, severity="warning"):
    merged = {}
    for item in errors or []:
        if not isinstance(item, dict):
            item = {"stage": "pipeline", "message": str(item)}
        stage = item.get("stage") or "pipeline"
        message = str(item.get("message") or item.get("text") or "").strip()
        key = (stage, message)
        record = merged.get(key)
        if record is None:
            record = {
                "stage": stage,
                "message": message,
                "text": message,
                "type": item.get("type") or severity,
                "lang": item.get("lang") or message_lang(message),
                "count": 0,
            }
            merged[key] = record
        record["count"] += int(item.get("count") or 1)
        for field, plural in (("cluster_id", "cluster_ids"), ("paper_id", "paper_ids")):
            values = list(item.get(plural) or [])
            if item.get(field) is not None:
                values.append(item[field])
            for value in values:
                bucket = record.setdefault(plural, [])
                if value not in bucket:
                    bucket.append(value)
    for record in merged.values():
        if record.get("cluster_ids"):
            record["cluster_id"] = record["cluster_ids"][0]
        if record.get("paper_ids"):
            record["paper_id"] = record["paper_ids"][0]
    return list(merged.values())
