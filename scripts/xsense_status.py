"""Status der X-Sense-Rauchmelder abfragen und als fire.json speichern.

Läuft als GitHub Action (siehe .github/workflows/rauchmelder.yml).
Zugangsdaten kommen aus den Umgebungsvariablen XSENSE_USER und XSENSE_PASS
(eigenes X-Sense-Konto, mit dem die Melder aus der App geteilt sind).

Die Datei enthält bewusst nur Raumnamen und Status, keine Seriennummern.
Für Alarme ist das nicht gedacht: die Abfrage läuft nur alle 30 Minuten.
"""
import json
import os
import sys
from datetime import datetime, timezone

OUT = sys.argv[1] if len(sys.argv) > 1 else 'fire.json'
PREFIX = 'Rauchmelder | '
OFFLINE_AFTER = 26 * 3600   # so lange ohne Meldung gilt ein Melder als offline


def clean_name(name: str) -> str:
    name = (name or '').strip()
    return name[len(PREFIX):] if name.startswith(PREFIX) else name


def to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def to_bool(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    return str(v) == '1'


def main():
    user, pw = os.environ.get('XSENSE_USER'), os.environ.get('XSENSE_PASS')
    if not user or not pw:
        sys.exit('XSENSE_USER und XSENSE_PASS fehlen')

    from xsense import XSense
    api = XSense()
    api.init()
    api.login(user, pw)
    api.load_all()

    now = datetime.now(timezone.utc)
    melder = []
    for house in api.houses.values():
        for st in (house.stations or {}).values():
            # WLAN-Melder ohne Basis: Status steht im Shadow «mainpage», unter der eigenen Seriennummer.
            # Das Flag onLine aus der Geräteliste ist unzuverlässig (Melder schlafen zwischen den Meldungen).
            data = {}
            try:
                res = api.get_thing(st, 'mainpage')
                rep = res.get('state', {}).get('reported', {})
                data = rep.get(st.sn) or next((v for v in rep.values() if isinstance(v, dict)), {})
            except Exception as e:
                print(f'::warning::{st.type}: Status nicht abrufbar ({type(e).__name__})')

            seen = None
            if t := data.get('onlineTime') or data.get('time'):
                try:
                    seen = datetime.strptime(str(t)[:14], '%Y%m%d%H%M%S').replace(tzinfo=timezone.utc)
                except ValueError:
                    pass
            melder.append({
                'name': clean_name(st.name),
                'typ': st.type,
                'online': (now - seen).total_seconds() < OFFLINE_AFTER if seen else None,
                'zuletzt': seen.strftime('%Y-%m-%dT%H:%M:%SZ') if seen else None,
                'batterie': to_int(data.get('batInfo')),       # 0 leer … 3 voll
                'wlan': to_int(data.get('wifiRssi') or data.get('wifiRSSI')),   # dBm
                'alarm': to_bool(data.get('alarmStatus')),
                'lebensende': to_bool(data.get('isLifeEnd')),
            })

    melder.sort(key=lambda m: m['name'])
    out = {
        'checked': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'melder': melder,
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(f'{len(melder)} Melder gespeichert')


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        # Als Annotation ausgeben, damit der Grund in der Übersicht des Laufs steht
        print(f'::error::{type(e).__name__}: {e}')
        sys.exit(1)
