"""Score question/abstract pairs with the pinned Qwen3 reranker loaded through transformers."""

from app.common import Cache, hf_snapshot, read_prompt, shared_model

TEMPLATE_KEYS = ("true_token", "false_token", "system", "prefix", "pair", "suffix", "instruction")


def parse_template(text):
    """Parse a reranker prompt file into its template fields.

    Args:
        text: Prompt file contents with `key: value` lines; `\\n` denotes a newline.

    Returns:
        dict holding every key in TEMPLATE_KEYS.
    """
    fields = {}
    for line in text.splitlines():
        key, separator, value = line.partition(": ")
        if separator and key in TEMPLATE_KEYS:
            fields[key] = value.replace("\\n", "\n")
    missing = [key for key in TEMPLATE_KEYS if not fields.get(key)]
    if missing:
        raise ValueError(f"Reranker prompt is missing fields: {', '.join(missing)}")
    fields["prefix"] = fields["prefix"].replace("{system}", fields["system"])
    return fields


class Reranker:
    def __init__(self, config):
        self.config = config
        self.model = None
        self.tokenizer = None
        self.cache = Cache(config.evaluation_cache / "reranker")

    def _load(self):
        if self.model is None:
            def load():
                from transformers import AutoModelForCausalLM, AutoTokenizer
                path = hf_snapshot(self.config.rerank_model, self.config.rerank_revision)
                return (AutoModelForCausalLM.from_pretrained(path).eval(),
                        AutoTokenizer.from_pretrained(path, padding_side="left"))
            self.model, self.tokenizer = shared_model(
                ("reranker", self.config.rerank_model, self.config.rerank_revision), load)
        return self.model, self.tokenizer

    def _score(self, texts, template):
        """Return P(yes) for each formatted pair, in the order of `texts`.

        Pairs are sorted by token length and grouped into batches of at most
        RERANK_BATCH_SIZE pairs and RERANK_BATCH_TOKENS padded tokens, so one
        very long abstract is scored on its own instead of forcing fifteen
        short ones to be padded to its length. Only the last position's logits
        are computed. Scores are returned in the original order.
        """
        import torch
        model, tokenizer = self._load()
        true_id = tokenizer.convert_tokens_to_ids(template["true_token"])
        false_id = tokenizer.convert_tokens_to_ids(template["false_token"])
        prefix = tokenizer.encode(template["prefix"], add_special_tokens=False)
        suffix = tokenizer.encode(template["suffix"], add_special_tokens=False)
        budget = self.config.rerank_max_tokens - len(prefix) - len(suffix)
        encoded = tokenizer(
            texts, padding=False, truncation="longest_first",
            return_attention_mask=False, max_length=budget,
        )["input_ids"]
        sequences = [prefix + ids + suffix for ids in encoded]
        order = sorted(range(len(sequences)), key=lambda index: (len(sequences[index]), index))
        scores = [0.0] * len(sequences)
        for indices in self._batches(order, sequences):
            inputs = tokenizer.pad({"input_ids": [sequences[index] for index in indices]},
                                   padding=True, return_tensors="pt")
            with torch.no_grad():
                logits = model(**inputs, logits_to_keep=1).logits[:, -1, :]
            pair = torch.stack([logits[:, false_id], logits[:, true_id]], dim=1)
            for index, score in zip(indices, torch.nn.functional.log_softmax(pair, dim=1)[:, 1].exp().tolist()):
                scores[index] = score
        return scores

    def _batches(self, order, sequences):
        batch = []
        for index in order:
            longest = len(sequences[index])
            if batch and (len(batch) >= self.config.rerank_batch_size
                          or (len(batch) + 1) * longest > self.config.rerank_batch_tokens):
                yield batch
                batch = []
            batch.append(index)
        if batch:
            yield batch

    def rank(self, question, papers):
        prompt = read_prompt(self.config.rerank_prompt)
        template = parse_template(prompt)
        keys, pending_text, pending_keys = [], [], []
        for paper in papers:
            document = paper.get("abstract") or paper.get("title") or ""
            key = {
                "model": self.config.rerank_model,
                "revision": self.config.rerank_revision,
                "prompt": prompt,
                "scoring_format": 3,
                "parameters": {"max_tokens": self.config.rerank_max_tokens},
                "question": question,
                "abstract": document,
            }
            keys.append(key)
            if self.cache.get(key) is None:
                pending_keys.append(key)
                pending_text.append(template["pair"].format(
                    instruction=template["instruction"], query=question, document=document))
        if pending_text:
            for key, score in zip(pending_keys, self._score(pending_text, template)):
                self.cache.put(key, float(score))
        for paper, key in zip(papers, keys):
            paper["relevance_score"] = float(self.cache.get(key))
        return sorted(papers, key=lambda item: (-item["relevance_score"], item.get("id", "")))
