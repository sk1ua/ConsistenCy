"""Mock Python engine for DeterministicAnalyzer tests. Located in tests/fixtures."""
import argparse
import json
import os
import sys
import time

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", nargs="?", default="normal")
    parser.add_argument("--state-file", dest="state_file", default=None)
    args, _ = parser.parse_known_args()

    # Read stdin JSON to extract real request id if available
    req_id = "req_mock_default"
    line = sys.stdin.readline()
    if line:
        line_str = line.strip()
        if line_str:
            try:
                data = json.loads(line_str)
                if isinstance(data, dict) and isinstance(data.get("id"), str):
                    req_id = data["id"]
            except Exception:
                pass

    if args.mode == "invalid_json":
        sys.stdout.write("THIS_IS_NOT_VALID_JSON\n")
        sys.stdout.flush()
        time.sleep(0.1)

    elif args.mode == "invalid_then_valid":
        state_file = args.state_file or ".mock_invalid_state"
        if not os.path.exists(state_file):
            with open(state_file, "w", encoding="utf-8") as f:
                f.write("failed")
            sys.stdout.write("THIS_IS_NOT_VALID_JSON\n")
            sys.stdout.flush()
            time.sleep(0.1)
        else:
            try:
                os.remove(state_file)
            except Exception:
                pass
            response = {"id": req_id, "ok": True, "files": []}
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()

    elif args.mode == "null_id":
        sys.stdout.write('{"id": null, "ok": false, "error": "Null id"}\n')
        sys.stdout.flush()
        time.sleep(0.1)

    elif args.mode == "unknown_id":
        sys.stdout.write('{"id": "unknown_req_id", "ok": true, "files": []}\n')
        sys.stdout.flush()
        time.sleep(0.1)

    elif args.mode == "schema_invalid":
        # Returns matching real request id but invalid schema ("files" is a string, not array)
        response = {"id": req_id, "ok": True, "files": "NOT_AN_ARRAY"}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()

    elif args.mode == "no_newline_large":
        sys.stdout.write("A" * (11 * 1024 * 1024))
        sys.stdout.flush()
        time.sleep(0.1)

    elif args.mode == "sleep_forever":
        time.sleep(3600)

if __name__ == "__main__":
    main()
