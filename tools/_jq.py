"""Tiny helper for the demo scripts: evaluate a Python expression over the JSON on stdin as `d`."""

import json
import sys

d = json.load(sys.stdin)
print(eval(sys.argv[1]))  # noqa: S307 - demo helper, expressions come from the scripts themselves
