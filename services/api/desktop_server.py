"""Frozen desktop backend; same-origin UI and authenticated loopback API."""
import os
import secrets
import socket
from pathlib import Path

import uvicorn
from fastapi.responses import FileResponse, JSONResponse
from app.main import app

web = Path(os.environ['DUOBOOK_WEB_DIR']).resolve()
token = os.environ['DUOBOOK_DESKTOP_TOKEN']


@app.middleware('http')
async def desktop_auth(request, call_next):
    if not secrets.compare_digest(request.headers.get('x-duobook-token', ''), token):
        return JSONResponse({'error': 'Unauthorized'}, status_code=401)
    response = await call_next(request)
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-src 'none'"
    )
    return response


@app.get('/{path:path}')
def frontend(path: str):
    if path.startswith('api/'):
        return JSONResponse({'error': 'Not found'}, status_code=404)
    target = (web / path).resolve()
    if not target.is_relative_to(web):
        return JSONResponse({'error': 'Not found'}, status_code=404)
    return FileResponse(target if target.is_file() else web / 'index.html')


if __name__ == '__main__':
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    print(f'DUOBOOK_PORT={sock.getsockname()[1]}', flush=True)
    config = uvicorn.Config(app, log_level='warning', access_log=False, loop='asyncio', ws='none', timeout_graceful_shutdown=5)
    uvicorn.Server(config).run(sockets=[sock])
