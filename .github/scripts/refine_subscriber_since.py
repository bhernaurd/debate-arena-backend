from pathlib import Path

path = Path('subscriptionAdminRoutes.js')
text = path.read_text()
old = "    return `COALESCE(original_purchase_date, purchase_date, created_at) DESC NULLS LAST, customer_key ASC`;"
new = "    return `subscriber_since DESC NULLS LAST, customer_key ASC`;"
assert old in text
text = text.replace(old, new, 1)
old = "    return `COALESCE(original_purchase_date, purchase_date, created_at) ASC NULLS LAST, customer_key ASC`;"
new = "    return `subscriber_since ASC NULLS LAST, customer_key ASC`;"
assert old in text
text = text.replace(old, new, 1)
old = "          canceling,\n          access_ends_at,\n          purchase_date,\n          original_purchase_date,\n"
new = "          canceling,\n          access_ends_at,\n          (\n            SELECT MIN(COALESCE(history.original_purchase_date, history.purchase_date, history.created_at))\n            FROM subscription_admin_customers_v1 history\n            WHERE history.customer_key = subscription_admin_current_customers_v1.customer_key\n              AND history.environment = subscription_admin_current_customers_v1.environment\n          ) AS subscriber_since,\n          purchase_date,\n          original_purchase_date,\n"
assert old in text
text = text.replace(old, new, 1)
path.write_text(text)

path = Path('lib/subscriptionAdminSubscribersUi.js')
text = path.read_text()
old = "function subscriberSince(r){ return r.original_purchase_date||r.purchase_date||r.created_at||null; }"
new = "function subscriberSince(r){ return r.subscriber_since||r.original_purchase_date||r.purchase_date||r.created_at||null; }"
assert old in text
path.write_text(text.replace(old, new, 1))

path = Path('test/subscriptionAdminSubscriberSorting.test.js')
text = path.read_text()
text = text.replace("assert.match(html,/original_purchase_date\\|\\|r\\.purchase_date\\|\\|r\\.created_at/);", "assert.match(html,/subscriber_since\\|\\|r\\.original_purchase_date/);")
text = text.replace("assert.match(source,/COALESCE\\(original_purchase_date, purchase_date, created_at\\) DESC NULLS LAST/);\n  assert.match(source,/COALESCE\\(original_purchase_date, purchase_date, created_at\\) ASC NULLS LAST/);", "assert.match(source,/subscriber_since DESC NULLS LAST/);\n  assert.match(source,/subscriber_since ASC NULLS LAST/);\n  assert.match(source,/SELECT MIN\\(COALESCE\\(history\\.original_purchase_date, history\\.purchase_date, history\\.created_at\\)\\)/);")
path.write_text(text)
