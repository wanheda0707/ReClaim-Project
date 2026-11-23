# ReClaim

ReClaim is a lost-and-found web app for PLM residents and external users. It has a React/Vite frontend and a Python FastAPI backend.

## Run locally

### Requirements

- Node.js and npm
- Python 3.11 or later

### 1. Get the project and install dependencies

```powershell
git clone https://github.com/wanheda0707/ReClaim-Project-Public.git
cd ReClaim-Project-Public
npm ci
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend/requirements.txt
Copy-Item .env.example .env
```

If PowerShell blocks activation, run the backend with `.\.venv\Scripts\python.exe backend/server.py` instead.

### 2. Configure Supabase

Edit `.env` and set the Supabase project URL and **publishable** browser key:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

Use the public publishable/anon key in the browser. Never put a service-role key in a `VITE_` variable or commit it. Backend-only Supabase settings belong in the private environment of the API host.

Apply the SQL migrations in `supabase/migrations` to the Supabase project before using hosted authentication and storage features. Email OTP delivery also needs the Supabase email provider configured. For local PLM registration via Microsoft Graph, configure the `MS_GRAPH_*` values in `.env`; without them, local development displays the OTP in the app and backend terminal.

### 3. Start the backend and frontend

Keep each process running in a separate terminal from the project root.

Terminal 1:

```powershell
python backend/server.py
```

Terminal 2:

```powershell
npm run dev
```

Open the local URL Vite prints (usually `http://localhost:8443`). Vite forwards `/api` calls to the local backend on port `3001`.

## Data and deployment

Local development stores workspace records on the local filesystem. For a shared hosted instance, deploy the frontend and API, configure the required Supabase and email settings as private host environment variables, apply the database migrations, and use persistent storage for records. See [backend deployment notes](backend/README.md). A local development server is not a public share link.

## Keep secrets private

`.env` is ignored by Git. Commit only `.env.example` with blank placeholders. Never publish service-role keys, Microsoft Graph client secrets, real student data, or production credentials.
