# Deploy one client instance (GCE VM)

Each client gets its own VM (or its own `WEB_PORT` on a shared VM), with its own Postgres
database. The stack is defined in `docker-compose.yml`:

| service | what it is |
|---|---|
| `web` | Next.js app: dashboard, login, saved scenarios, Excel export. Published on `WEB_PORT` (80). |
| `engine` | Python/FastAPI engine (FDRE optimizer, finance, EYA, tender review). Internal only. |
| `db` | Postgres 16. Data in the Docker volume `fdre_pgdata`. |

## First install

1. The VM needs a public IP and port 80 open. For `tariff-order`, this is already done
   (static IP `fdre-ip`, 34.131.67.235; firewall rule `allow-http-80`).
2. On the VM:
   ```sh
   git clone -b claude/intelligent-carson-mwonct https://github.com/Ergplan/FDRE.git fdre
   cd fdre && sudo bash deploy/gce/install.sh
   ```
   The script installs Docker, writes `.env` with random secrets, builds and starts the
   containers, and schedules a daily database backup. It also removes the earlier
   nginx/systemd install if one exists.
3. Open `http://<external IP>/`. The first visitor is asked to create the **administrator**
   account. Add colleagues under **Users**.

About 4 GB RAM is recommended (e2-medium). The first build takes 5–10 minutes.

## Update

```sh
cd ~/fdre && git pull && sudo bash deploy/gce/install.sh
```

## Operate

```sh
sudo docker compose ps                 # status
sudo docker compose logs -f web        # web app logs (also: engine, db)
sudo bash deploy/backup.sh             # backup now → backups/*.sql.gz
gunzip -c backups/<file>.sql.gz | sudo docker compose exec -T db psql -U fdre -d fdre   # restore
```

Keep `.env`. It holds the database password and the session secret. Changing
`SESSION_SECRET` signs everyone out.

## HTTPS

With a domain name pointed at the VM, put a TLS proxy (for example Caddy) in front of port 80
and set `COOKIE_SECURE=true` in `.env`.
