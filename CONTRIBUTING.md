# Contributing

Thanks for your interest in DCA Strategy Assistant! This document covers the minimum you need to get started.

## Prerequisites

- Python 3.10+
- Node.js 18+
- Git

## Setup

```powershell
# Clone
git clone https://github.com/jerry9692/DCA-strategy-assistant.git
cd DCA-strategy-assistant

# One-click install + start (Windows)
.\start-dev.ps1 -Install
```

Or manually:

```bash
# Backend
cd backend
python -m venv .venv
.venv/Scripts/activate   # Windows
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

## Running Tests

```bash
cd backend
.venv/Scripts/python -m pytest tests -q
```

Frontend type check:

```bash
cd frontend
npx tsc --noEmit
```

## Code Style

- **Backend**: formatted with `ruff format`, linted with `ruff check`. Run `ruff check --fix .` before committing.
- **Frontend**: formatted with Prettier, linted with ESLint. Run `npm run lint` before committing.

## Commit Messages

Use conventional-ish format:

```
<scope>: <short summary>

<optional body>
```

Examples: `backtester: fix weekend duplicate buy`, `frontend: migrate charts to time axis`.

## Pull Requests

1. Create a feature branch from `main`.
2. Make your changes, add tests if applicable.
3. Ensure `pytest` and `tsc --noEmit` pass.
4. Open a PR against `main` with a clear description.

## License

By contributing you agree that your contributions will be licensed under the MIT License.
