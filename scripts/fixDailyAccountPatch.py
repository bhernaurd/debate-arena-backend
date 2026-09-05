from pathlib import Path

path = Path('scripts/patchDailyAccountAnalytics.py')
text = path.read_text()
text = text.replace(
    'old = """      `<div class=\\"grid accounts-metrics\\"',
    'old = """<div class=\\"grid accounts-metrics\\"',
    1,
)
text = text.replace(
    'new = """      `<div class=\\"grid accounts-metrics\\"',
    'new = """<div class=\\"grid accounts-metrics\\"',
    1,
)
path.write_text(text)
