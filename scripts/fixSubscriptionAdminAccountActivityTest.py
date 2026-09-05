from pathlib import Path

path = Path('test/subscriptionAdminAccountActivity.test.js')
text = path.read_text()
old = '  <section id="view-history" class="hidden"></section>'
new = '    <section id="view-history" class="hidden"></section>'
if old not in text:
    raise SystemExit('account activity test section fixture anchor not found')
path.write_text(text.replace(old, new, 1))
