York IE VECOS diagnostic bundle
Exported at: 2026-09-17T09:51:15.616Z

Included files:
- Application log files (*.log)
- system-info.json
- diagnostics-summary.json
- updater-diagnostics.json (auto-update state + ShipIt log tails)
- shipit/ShipIt_*.log when present (macOS Squirrel install)

Search app logs for [AutoUpdater] (WARN level — written even when developer logs are off).

diagnostics-summary.json contains a redacted runtime/config snapshot,
plus metadata-only session summaries and recent error traces to speed up debugging.