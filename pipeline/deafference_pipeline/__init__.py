"""Offline landmark extraction for the Deafference motion studio.

Only tracker inference lives in Python. Cleaning, solving, filtering, export
and QA are implemented in TypeScript (``tools/``) so the browser live mode and
the offline pipeline share one solver implementation.
"""

RAW_SCHEMA = "deafference.raw-landmarks"
RAW_SCHEMA_VERSION = 1
