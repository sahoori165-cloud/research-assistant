"""Request constrained, cacheable summaries from exact Ollama model."""
import json
import requests
from app.common import Cache, read_prompt, request_with_retry, verify_ollama

SCHEMA = {
    "type": "object",
    "properties": {
        "cluster_label": {"type": "string"},
        "summary": {"type": "string"},
        "key_papers": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 5},
        "open_questions": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 3},
        "source_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        "claims": {
            "type": "array",
            "minItems": 2,
            "maxItems": 4,
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "source_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1}
                },
                "required": ["text", "source_ids"],
                "additionalProperties": False
            }
        }
    },
    "required": ["cluster_label", "summary", "key_papers", "open_questions", "source_ids", "claims"],
    "additionalProperties": False
}

class OllamaClient:
    def __init__(self, config):
        self.config = config
        self.cache = Cache(config.evaluation_cache / "summaries")
        self.verified_digest = None

    def _ensure_pinned(self):
        if self.verified_digest is None:
            self.verified_digest = verify_ollama(self.config)
        return self.verified_digest

    def synthesise(self, cluster, papers):
        allowed = [
            paper for paper in papers
            if paper.get("cluster_id") == cluster["cluster_id"]
            and paper.get("status") not in ("retracted", "unverified")
            and paper.get("abstract")
        ]
        if len(allowed) < 2:
            raise ValueError("At least two verified, non-retracted abstracts are required for a grounded synthesis")
        source = [
            {"id": item["id"], "title": item["title"], "abstract": item["abstract"][:self.config.synthesis_abstract_chars]}
            for item in allowed[:self.config.synthesis_max_sources]
        ]
        prompt = read_prompt(self.config.synthesis_prompt)
        key = {
            "model": self.config.ollama_model,
            "revision": self.config.ollama_digest,
            "prompt": prompt,
            "parameters": {
                "temperature": self.config.temperature,
                "seed": self.config.seed,
                "schema": SCHEMA
            },
            "cluster": cluster["label"],
            "sources": source
        }
        result = self.cache.get(key)
        if result is None:
            self._ensure_pinned()
            payload = {
                "model": self.config.ollama_model,
                "messages": [
                    {"role": "system", "content": prompt},
                    {
                        "role": "user",
                        "content": json.dumps(
                            {"theme": cluster["label"], "abstracts": source},
                            ensure_ascii=False
                        )
                    }
                ],
                "format": SCHEMA,
                "stream": False,
                "think": False,
                "options": {
                    "temperature": self.config.temperature,
                    "seed": self.config.seed
                }
            }
            response = request_with_retry(
                requests, "POST", self.config.ollama_url,
                self.config.ollama_timeout, self.config.ollama_retries, json=payload
            )
            response.raise_for_status()
            result = json.loads(response.json()["message"]["content"])
            if isinstance(result, dict) and isinstance(result.get("claims"), list):
                claims = result["claims"]
                if all(
                    isinstance(claim, dict)
                    and isinstance(claim.get("text"), str)
                    and isinstance(claim.get("source_ids"), list)
                    for claim in claims
                ):
                    result["summary"] = " ".join(claim["text"].strip() for claim in claims)
                    result["source_ids"] = list(dict.fromkeys(
                        source_id for claim in claims for source_id in claim["source_ids"]
                    ))
            self.validate(result, source)
            self.cache.put(key, result)
        else:
            self.validate(result, source)
        return result

    @staticmethod
    def validate(result, source):
        if not isinstance(result, dict) or set(result) != set(SCHEMA["required"]):
            raise ValueError("Ollama response does not match the required schema")
        if not isinstance(result["cluster_label"], str) or not isinstance(result["summary"], str) or not result["summary"].strip():
            raise ValueError("Invalid summary or label")
        titles = {item["title"] for item in source}
        ids = {item["id"] for item in source}
        for field, low, high in (
            ("key_papers", 2, 5),
            ("open_questions", 1, 3),
            ("source_ids", 1, len(ids))
        ):
            data = result[field]
            if not isinstance(data, list) or not low <= len(data) <= high or any(not isinstance(value, str) for value in data):
                raise ValueError(f"Invalid {field}")
        if any(title not in titles for title in result["key_papers"]):
            raise ValueError("Summary referenced a title outside the source abstracts")
        if any(value not in ids for value in result["source_ids"]):
            raise ValueError("Summary referenced an unknown source")
        claims = result["claims"]
        if not isinstance(claims, list) or not 2 <= len(claims) <= 4:
            raise ValueError("Summary needs 2 to 4 attributable claims")
        for claim in claims:
            if not isinstance(claim, dict) or set(claim) != {"text", "source_ids"} or not isinstance(claim["text"], str) or not claim["text"].strip():
                raise ValueError("Invalid attributable claim")
            if not isinstance(claim["source_ids"], list) or not claim["source_ids"] or any(
                not isinstance(value, str) or value not in ids for value in claim["source_ids"]
            ):
                raise ValueError("Claim referenced an unknown source")
        expected_summary = " ".join(claim["text"].strip() for claim in claims)
        if result["summary"] != expected_summary:
            raise ValueError("Summary does not match the attributable claims")
        expected_ids = {source_id for claim in claims for source_id in claim["source_ids"]}
        if set(result["source_ids"]) != expected_ids:
            raise ValueError("Summary source IDs do not match the claim sources")
