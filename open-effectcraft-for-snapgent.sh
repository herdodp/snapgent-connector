#!/usr/bin/env bash
set -u

cd "$(dirname "$0")" || exit 1

PY=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
        "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
        PY="$candidate"
        break
    fi
done

if [ -z "$PY" ]; then
    echo "Python 3.9 or newer is required to configure EffectCraft for Snapgent."
    exit 1
fi

"$PY" ./setup-config.py --launch-effectcraft
result=$?
if [ "$result" -ne 0 ]; then
    echo "EffectCraft setup failed. Review the error above, then try again."
    exit "$result"
fi

echo
echo "EffectCraft setup finished. Review the messages above for its connection status."
echo "Run the Snapgent bridge launcher to start or restart the bridge and connect to EffectCraft."
