"""Undo a "use Claude tonight" switch in settings.local.json (Jer 2026-11-22: Claude quota allowed until midnight).

Puts back the models saved under modelsBeforeTonight, ends the day at 22:00 again and clears claudeFallback.
Safe to rerun: with nothing saved it changes nothing. Usage: python -I end-claude-night.py [settings file]
"""
import json
import sys
from pathlib import Path

path = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'settings.local.json')
data = json.loads(path.read_text(encoding='utf-8'))
saved = data.pop('modelsBeforeTonight', None)
if saved:
    data['models'] = saved
    data['activeHours'] = {'start': '08:00', 'end': '22:00'}
    data.pop('claudeFallback', None)
    path.write_text(json.dumps(data, indent=2), encoding='utf-8')
    print(f'restored {len(saved)} models, day ends 22:00, Claude fallback off')
else:
    print('nothing to restore')
