"""
backend/auth/dependencies.py

FastAPI dependency: get_session.

Reads the verified session_id that SessionMiddleware stores in request.state
and returns it to route handlers and WebSocket endpoints.

Usage (HTTP):
    @app.get("/some-route")
    async def handler(session_id: str = Depends(get_session)):
        ...

Usage (WebSocket):
    @app.websocket("/ws/{user_id}/{session_id}")
    async def ws_handler(ws: WebSocket, session_id: str = Depends(get_session)):
        ...

The dependency raises HTTP 401 only if SessionMiddleware is absent from the
middleware stack (configuration error). In correct deployments, SessionMiddleware
always populates request.state.session_id before any route handler executes.
"""
from __future__ import annotations

from fastapi import HTTPException, Request, status


async def get_session(request: Request) -> str:
    """
    Return the verified session_id for the current request or WebSocket connection.

    The value is populated by SessionMiddleware before any route handler runs.
    Injectable into HTTP routes and WebSocket endpoints via Depends().

    Raises:
        HTTPException(401): If session_id is absent from request.state, which
            indicates a misconfigured middleware stack (never happens in production).
    """
    session_id: str | None = getattr(request.state, "session_id", None)
    if not session_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="No authenticated session. Ensure the wafrivet_session cookie is present.",
            headers={"WWW-Authenticate": "Cookie"},
        )
    return session_id
