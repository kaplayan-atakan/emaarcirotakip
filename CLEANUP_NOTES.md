# Cleanup Notes (2025-08-26)

This repository was reorganized to separate runtime code from one-off analysis scripts and setup SQL.

## Moved Files

Analysis scripts moved to `scripts/analysis/`:
- analyze-difference.js
- analyze-sent-data.js
- deep-analysis.js
- final-analysis.js
- fix-personel-log.js
- check-structure.js
- setup-monthly-table.js (setup utility retained for reruns)

Database setup scripts moved to `db/`:
- database-setup.sql
- database-monthly-setup.sql

Legacy / not currently used moved to `archive/`:
- index.html (login UI is rendered inline in `index.js`)
- monthly-reports.js (not referenced by `index.js` at this time)
- monthlySalesApiDoc.txt (documentation, keep for reference)

## Added / Updated
- `.gitignore` extended to ignore logs, temp, env, coverage, and analysis output.
- Created structured folders: `scripts/analysis`, `db`, `archive`.

## Next Suggested Steps
1. Introduce `.env` and refactor sensitive credentials out of `index.js`.
2. Add a `README.md` section describing new structure.
3. Implement `dailyScheduler.js` and remove obsolete 3-day scheduler.
4. Consider adding lightweight tests for monthly operations aggregation.

---
If any script is still needed in root for operational reasons, move it back or create a wrapper entry in `package.json` scripts.
