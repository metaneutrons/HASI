#!/usr/bin/env bash
# Run locally in an interactive terminal. Never pass credentials as arguments.
set +x
set -euo pipefail
umask 077

command -v fnox >/dev/null || { printf '%s\n' 'fnox fehlt im PATH.' >&2; exit 1; }
command -v python3 >/dev/null || { printf '%s\n' 'python3 fehlt im PATH.' >&2; exit 1; }

python3 - <<'PY'
import getpass
import os
from pathlib import Path
import re
import subprocess
import tempfile
import tomllib
import warnings

warnings.simplefilter('error', getpass.GetPassWarning)
config = Path.home() / '.config/fnox/config.toml'
if not config.is_file():
    raise SystemExit('Zuerst fnox mit dem globalen age-Provider einrichten.')


def mark_exec_only(name):
    # Resolve the iCloud symlink before atomically replacing its target.
    target = config.resolve(strict=True)
    source = target.read_text()
    lines = source.splitlines(keepends=True)
    matches = [i for i, line in enumerate(lines) if re.match(rf'^{re.escape(name)}\s*=', line)]
    if len(matches) != 1 or not lines[matches[0]].rstrip().endswith('}'):
        raise SystemExit(f'{name}: unerwartetes fnox-Format; exec-only konnte nicht gesetzt werden.')
    index = matches[0]
    line = lines[index].rstrip()
    line = re.sub(r',?\s*env\s*=\s*"[^"]*"\s*', '', line)
    lines[index] = line[:-1].rstrip().rstrip(',') + ', env = "exec" }\n'
    updated = ''.join(lines)
    assert tomllib.loads(updated)['secrets'][name]['env'] == 'exec'
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=target.parent, prefix='.hasi-fnox-', delete=False) as handle:
            temporary = Path(handle.name)
            os.chmod(temporary, 0o600)
            handle.write(updated)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


print('HASI: GWDG-Key verschlüsselt in fnox hinterlegen.')
print('Vorhandene Werte werden übersprungen; Zugriff anschließend nur über fnox exec.')
print('Der Demo-Schlüssel wird separat vom Betreiber verwaltet; hier ist nur der GWDG-Key nötig.\n')

try:
    for name in ['GWDG_API_KEY']:
        existing = tomllib.loads(config.read_text()).get('secrets', {})
        if name in existing:
            mark_exec_only(name)
            print(f'{name}: bereits vorhanden, unverändert übernommen (exec-only).')
            continue
        while True:
            value = getpass.getpass(f'{name} (verdeckte Eingabe): ')
            if not value or value != value.strip() or any(character in value for character in '\r\n\0'):
                print('Bitte einen nicht leeren Wert ohne umgebende Leerzeichen eingeben.')
                continue
            confirmation = getpass.getpass('Zur Kontrolle wiederholen: ')
            if value != confirmation:
                print('Die Eingaben stimmen nicht überein.')
                continue
            del confirmation
            break
        result = subprocess.run(
            ['fnox', 'set', name, '-g', '-p', 'age'],
            input=value.encode(), capture_output=True,
        )
        del value
        if result.returncode:
            raise SystemExit(f'{name}: Speichern fehlgeschlagen. Keine geheimen Diagnoseausgaben anzeigen.')
        try:
            mark_exec_only(name)
        except (Exception, SystemExit, KeyboardInterrupt):
            raise SystemExit(
                f'{name}: Der Wert wurde bereits verschlüsselt gespeichert, aber exec-only '
                'konnte nicht bestätigt werden. Vor weiteren Shell-Starts den Eintrag in '
                '~/.config/fnox/config.toml auf env = "exec" prüfen. '
                'Das Skript nach der Korrektur erneut ausführen.'
            )
        print(f'{name}: verschlüsselt gespeichert (exec-only).')
except (KeyboardInterrupt, EOFError, getpass.GetPassWarning):
    raise SystemExit('\nAbgebrochen. Bereits gespeicherte Einträge bleiben erhalten.')

print('\nFertig. Bitte nur „hinterlegt“ bestätigen, keine Schlüssel in den Chat kopieren.')
PY
