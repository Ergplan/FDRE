# FDRE React Demo

Polished client-demo frontend for the FDRE optimizer. The React app calls a FastAPI wrapper around the existing Python engine, so solver logic remains in `fdre_enterprise_engine.py`.

## Run

From `FDRE_Optimizer/react_demo`:

```bash
python3 -m uvicorn backend.api:app --reload --port 8000
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

## Build And Serve From FastAPI

```bash
npm run build
python3 -m uvicorn backend.api:app --port 8000
```

Open `http://127.0.0.1:8000`.

## Notes

- The backend auto-loads `/Users/rachitagarwal/Downloads/Wind Generation Bikaner.csv` when available.
- P50/P75/P90 wind yield selection is passed to the same `custom_cf` pathway used by the Streamlit app.
- Optimizer uses the existing HiGHS-seeded capacity search.
