import argparse
import json
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
for flag in ("questions", "items", "out", "task", "context-file"):
    parser.add_argument("--" + flag, required=True)
parser.add_argument("--public", action="store_true")
args = parser.parse_args()
assert sys.flags.isolated and args.public and args.task == "idea-generator filter"
question = json.loads(Path(args.questions).read_text(encoding="utf-8"))["fit"]
assert question["type"] == "noul" and set(question["criteria"]) == {"true_description", "false_description"}
context = Path(args.context_file).read_text(encoding="utf-8")
assert "TEST goal" in context and "TEST interests" not in context  # goal only since 2026-11-23
if "TEST force failure" in context:
    sys.exit(3)

with Path(args.out).open("w", encoding="utf-8") as out:
    for line in Path(args.items).read_text(encoding="utf-8").splitlines():
        item = json.loads(line)
        title, summary, url = item["text"].split("\n", 2)
        assert summary == "TEST summary" and url.startswith("https://example.test/")
        for score in (0.05, float(title.split()[-1])):
            print(json.dumps({"id": item["id"], "ok": True, "answers": {"fit": {"noul": score}}}), file=out)
