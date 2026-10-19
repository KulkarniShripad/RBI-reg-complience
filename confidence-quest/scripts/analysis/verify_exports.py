"""Loads the three main CSVs and reproduces the app's status counts (standard library only).

Usage:
    python3 scripts/analysis/verify_exports.py <export-dir> [status.json]

<export-dir> holds participants.csv, questions_long.csv and surveys_long.csv.
status.json is the JSON from GET /admin/api/status (optional). When given, the counts
from the CSVs are compared with the app's "live" counts and the script prints MATCH or
exits with an error.
"""
import csv
import json
import sys
from collections import Counter
from pathlib import Path


def read(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    folder = Path(sys.argv[1])
    participants = read(folder / "participants.csv")
    questions = read(folder / "questions_long.csv")
    surveys = read(folder / "surveys_long.csv")

    by_arm_status = Counter((p["arm"] or "unassigned", p["status"]) for p in participants)
    print(f"participants: {len(participants)}")
    for (arm, status), n in sorted(by_arm_status.items()):
        print(f"  {arm:<13} {status:<12} {n}")

    # Cross-checks between the files.
    codes = {p["participant_code"] for p in participants}
    assert {q["participant_code"] for q in questions} <= codes, "questions_long has unknown participants"
    assert {s["participant_code"] for s in surveys} <= codes, "surveys_long has unknown participants"
    for p in participants:
        if p["score_raw"]:
            correct = sum(
                1 for q in questions if q["participant_code"] == p["participant_code"] and q["is_correct"] == "1"
            )
            assert correct == int(p["score_raw"]), f"score mismatch for {p['participant_code']}"
    print(f"answers: {len(questions)}, survey rows: {len(surveys)}, scores consistent")

    if len(sys.argv) > 2:
        status = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))["live"]
        problems = []
        if status["total"] != len(participants):
            problems.append(f"total: app {status['total']} vs csv {len(participants)}")
        for arm, counts in status["by_arm"].items():
            for state in ("in_progress", "completed", "abandoned", "withdrawn"):
                if counts[state] != by_arm_status.get((arm, state), 0):
                    problems.append(f"{arm}/{state}: app {counts[state]} vs csv {by_arm_status.get((arm, state), 0)}")
        if problems:
            sys.exit("MISMATCH\n  " + "\n  ".join(problems))
        print("MATCH: CSV counts equal the app's status counts")


if __name__ == "__main__":
    main()
