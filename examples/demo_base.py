"""Baseline implementation used by the multi-agent demo."""


def load_user_profile(user_id: str) -> dict:
    """Return a normalized user profile."""
    if not user_id:
        raise ValueError("user_id is required")
    return {
        "id": user_id,
        "status": "active",
        "roles": ["reader"],
    }


def render_profile(profile: dict) -> str:
    return f"{profile['id']}:{profile['status']}"
