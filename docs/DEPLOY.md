# Running the agent on a server

The agent is a single Node process plus a `data/` directory. Any machine that
stays on will do; the smallest VPS tier is enough.

**Nobody hosts this for you.** The server, the account and the bill are yours,
the same way the API keys are.

---

## What it costs

| Option | Rough cost | Notes |
|---|---|---|
| Hetzner CX22 | ~€4/month | Cheapest sane VPS; you manage the OS |
| DigitalOcean / Vultr | ~$6/month | Same shape, more hand-holding |
| Railway / Fly.io | ~$5/month | Deploys from the Dockerfile, no OS to manage |
| Your own PC | €0 | Only collects data while it is switched on |

A missing hour is missing observations, not a broken run — state and the
journal persist across restarts.

---

## Before you expose anything

The dashboard shows a live portfolio, its open positions and every signal. It
is read-only — there is no endpoint that can place or cancel an order — but
that is still not something to leave open to the internet.

Two ways to reach it, in order of preference:

### 1. SSH tunnel (recommended, nothing exposed)

Leave the server bound to loopback and forward the port over SSH:

```bash
ssh -N -L 3000:127.0.0.1:3000 you@your-server
```

Then open `http://127.0.0.1:3000` on your own machine. Nothing is published,
and there is no password to leak.

### 2. Public with a password

```bash
DASHBOARD_HOST=0.0.0.0
DASHBOARD_USER=you
DASHBOARD_PASSWORD=<at least 12 characters>
```

The process **refuses to start** if you set a non-loopback host without a
password, or with one shorter than 12 characters. There is no override flag —
an override becomes the thing everyone sets.

Put it behind HTTPS. Basic auth over plain HTTP sends the password in
base64 on every request, which is encoding, not encryption. Caddy is the
shortest path:

```
dashboard.yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy obtains and renews the certificate itself.

---

## Docker

```bash
docker build -t ai-market-agent .

docker run -d \
  --name agent \
  --restart unless-stopped \
  --env-file .env \
  -v agent-data:/app/data \
  -p 127.0.0.1:3000:3000 \
  ai-market-agent
```

Note `-p 127.0.0.1:3000:3000` — binding the *host* side to loopback means the
port is not published even if the container listens broadly. Drop the
`127.0.0.1:` prefix only once a password is set.

The named volume is not optional. Without it, every `docker run` starts the
portfolio from its opening balance and the track record never accumulates past
one container lifetime.

```bash
docker logs -f agent          # follow
docker restart agent          # state survives
```

---

## Plain systemd, no Docker

```bash
git clone https://github.com/Makooff/SwiftyRX.git /opt/agent
cd /opt/agent
npm ci --omit=dev
```

`/etc/systemd/system/agent.service`:

```ini
[Unit]
Description=AI Market Agent (paper)
After=network-online.target

[Service]
Type=simple
User=agent
WorkingDirectory=/opt/agent
ExecStart=/usr/bin/npx tsx scripts/paper.ts
Restart=always
RestartSec=30
Environment=NODE_ENV=production
Environment=LOG_PRETTY=false

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now agent
journalctl -u agent -f
```

`Restart=always` matters: the agent checkpoints after every cycle, so a crash
costs one cycle rather than the run.

---

## Getting `.env` onto the server

Never through Git. It is gitignored for a reason, and a key pushed to a public
repository is scanned by bots within minutes.

```bash
scp .env you@your-server:/opt/agent/.env
ssh you@your-server 'chmod 600 /opt/agent/.env'
```

If a key ever does reach a commit, rotate it. Deleting the file does not remove
it from the history.

---

## After deploying

```bash
npm run doctor          # what works, what is missing
npm run sources:check   # do the APIs answer from this machine?
```

Run both **on the server**. A residential IP and a datacentre IP are not the
same client to every provider — the SEC in particular rate-limits by IP.

---

## What to watch

- `npm run doctor` after any config change.
- The **System health** panel: a source that goes `unavailable` and stays there
  is a dead feed, not a blip.
- **Risk rejections** on the dashboard. A rising count is information, not a
  fault — it is the engine refusing trades, which is most of its job.
- Cycle count against uptime. Cycles that stop advancing while the process
  lives means the loop is stuck, and nothing else will tell you.
