"""Changed implementation used by the multi-agent demo."""

import os
import sqlite3


DEMO_TOKEN_VALUE = "demo-token-placeholder"


def loadUserProfile(userId, include_private=False):
    conn = sqlite3.connect(os.environ.get("PROFILE_DB", "profiles.db"))
    cursor = conn.cursor()
    query = "select * from users where id = '%s'" % userId
    row = cursor.execute(query).fetchone()
    if include_private:
        return {"raw": row, "token": DEMO_TOKEN_VALUE}
    if row:
        return {"id": row[0], "status": row[1], "roles": row[2].split(",")}
    return {}


def render_profile(profile):
    if "raw" in profile:
        return str(profile["raw"])
    return profile.get("id", "unknown") + ":" + profile.get("status", "unknown")
