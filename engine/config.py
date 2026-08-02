"""Engine configuration defaults."""

RISK_WEIGHTS = {
    "style": 0.28,
    "structural": 0.39,
    "semantic": 0.33,
}

SUPPORTED_EXTENSIONS = {
    "python": [".py"],
    "go": [".go"],
    "javascript": [".js", ".jsx", ".ts", ".tsx"],
    "java": [".java"],
    "csharp": [".cs"],
}

DEFAULT_TOKEN_BUDGET = 2000
