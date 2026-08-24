from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'Expected one {label} anchor, found {count}')
    return source.replace(old, new, 1)

routes = Path('subscriptionAdminDashboardRoutes.js')
source = routes.read_text()
if "from './lib/subscriptionAdminOverviewUi.js'" not in source:
    anchor = "import {\n  enhanceSubscriptionAdminPayoutHtml,\n} from './lib/subscriptionAdminPayoutUi.js';"
    replacement = anchor + "\nimport {\n  enhanceSubscriptionAdminOverviewHtml,\n} from './lib/subscriptionAdminOverviewUi.js';"
    source = replace_once(source, anchor, replacement, 'overview UI import')

old = "          ? enhanceSubscriptionAdminPayoutHtml(\n              enhanceSubscriptionAdminHistoryHtml(\n                enhanceDashboardHtml(body)\n              )\n            )"
new = "          ? enhanceSubscriptionAdminOverviewHtml(\n              enhanceSubscriptionAdminPayoutHtml(\n                enhanceSubscriptionAdminHistoryHtml(\n                  enhanceDashboardHtml(body)\n                )\n              )\n            )"
if 'enhanceSubscriptionAdminOverviewHtml(' not in source.split('res.send = (body) => {', 1)[1]:
    source = replace_once(source, old, new, 'overview enhancer composition')
routes.write_text(source)

package = Path('package.json')
source = package.read_text()
if 'node --check lib/subscriptionAdminOverviewUi.js' not in source:
    anchor = 'node --check lib/subscriptionAdminPayoutUi.js && node --check lib/appStoreConnectReportsService.js'
    replacement = 'node --check lib/subscriptionAdminPayoutUi.js && node --check lib/subscriptionAdminOverviewUi.js && node --check lib/appStoreConnectReportsService.js'
    source = replace_once(source, anchor, replacement, 'package overview check')
package.write_text(source)
