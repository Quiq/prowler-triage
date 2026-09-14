from flask import Flask

ENV_COLOR_COUNT = 8

PROVIDER_ICONS = {
    "aws": "aws_provider.png",
    "gcp": "gcp_provider.png",
    "azure": "azure_provider.png",
}


def provider_icon(provider_name):
    """Static img path for a provider's logo, or None if we don't have one —
    template should skip rendering an <img> rather than show a broken link."""
    filename = PROVIDER_ICONS.get((provider_name or "").lower())
    return f"/static/img/{filename}" if filename else None


def env_color_class(env_name):
    """Stable color index for an auto-discovered environment name, so any
    number of environments get a distinct, consistent badge color without a
    hardcoded CSS rule per name (see .env-color-0..7 in style.css).

    Assigned by position within the sorted list of currently-discovered
    environments (not a name hash) so that up to ENV_COLOR_COUNT
    environments never collide on the same color.
    """
    from .data import ENVIRONMENTS

    names = sorted(ENVIRONMENTS.keys())
    idx = names.index(env_name) % ENV_COLOR_COUNT if env_name in names else 0
    return f"env-color-{idx}"


def create_app():
    app = Flask(__name__)
    app.jinja_env.trim_blocks = True
    app.jinja_env.lstrip_blocks = True
    app.jinja_env.filters["env_color_class"] = env_color_class
    app.jinja_env.filters["provider_icon"] = provider_icon

    from . import routes

    app.register_blueprint(routes.bp)

    return app
