# FDRE engine API

`backend/api.py` is the FastAPI service that wraps the Python optimizer, finance, EYA and
tender-review modules. The user interface is the Next.js app in `../web`, which forwards
engine calls here for signed-in users. Do not expose this service to the internet directly;
in `docker-compose.yml` it is only reachable from the web container.

```sh
python -m uvicorn backend.api:app --port 8000
```
