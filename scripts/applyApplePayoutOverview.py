from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"Expected one {label} anchor, found {count}")
    return source.replace(old, new, 1)


service = Path('lib/subscriptionAdminHistoryService.js')
source = service.read_text()
if "from './appleFiscalCalendar.js'" not in source:
    source = replace_once(
        source,
        "const HISTORY_TIME_ZONE = 'America/Chicago';",
        "import { getAppleFiscalPayoutCalendar } from './appleFiscalCalendar.js';\n\nconst HISTORY_TIME_ZONE = 'America/Chicago';",
        'history service import',
    )
if 'payoutCalendar: getAppleFiscalPayoutCalendar()' not in source:
    source = replace_once(
        source,
        "    financialPeriods,\n  };",
        "    financialPeriods,\n    payoutCalendar: getAppleFiscalPayoutCalendar(),\n  };",
        'history service return',
    )
service.write_text(source)


routes = Path('subscriptionAdminDashboardRoutes.js')
source = routes.read_text()
if "from './lib/subscriptionAdminPayoutUi.js'" not in source:
    import_anchor = "import {\n  enhanceSubscriptionAdminHistoryHtml,\n} from './lib/subscriptionAdminHistoryUi.js';"
    import_replacement = import_anchor + "\nimport {\n  enhanceSubscriptionAdminPayoutHtml,\n} from './lib/subscriptionAdminPayoutUi.js';"
    source = replace_once(source, import_anchor, import_replacement, 'dashboard payout UI import')
if 'enhanceSubscriptionAdminPayoutHtml(' not in source.split('res.send = (body) => {', 1)[1]:
    composition_anchor = "          ? enhanceSubscriptionAdminHistoryHtml(\n              enhanceDashboardHtml(body)\n            )"
    composition_replacement = "          ? enhanceSubscriptionAdminPayoutHtml(\n              enhanceSubscriptionAdminHistoryHtml(\n                enhanceDashboardHtml(body)\n              )\n            )"
    source = replace_once(source, composition_anchor, composition_replacement, 'dashboard enhancer composition')
routes.write_text(source)


package = Path('package.json')
source = package.read_text()
if 'node --check lib/appleFiscalCalendar.js' not in source:
    check_anchor = 'node --check lib/subscriptionAdminHistoryUi.js && node --check lib/appStoreConnectReportsService.js'
    check_replacement = 'node --check lib/subscriptionAdminHistoryUi.js && node --check lib/appleFiscalCalendar.js && node --check lib/subscriptionAdminPayoutUi.js && node --check lib/appStoreConnectReportsService.js'
    source = replace_once(source, check_anchor, check_replacement, 'package check')
package.write_text(source)
