# RCB Ticket Monitor 🎟️

Automatically checks rcb.in every 2 minutes and sends a push notification to your phone the moment RCB vs SRH IPL 2026 tickets go live.

## Stack
- **Netlify** — hosts the dashboard + runs the scheduled function
- **ntfy.sh** — delivers push notifications (free, no account needed)

## Deploy in 3 Steps

### 1. Set up ntfy on your phone
- Install the **ntfy** app (Android / iOS)
- Open the deployed site — it generates a unique topic ID for you
- In ntfy app: tap **+** → enter your topic ID → Subscribe

### 2. Deploy to Netlify
- Go to [netlify.com](https://netlify.com) → Add new site → Deploy manually
- Drag and drop this entire folder (rcb-monitor) into Netlify

### 3. Add environment variable
- In Netlify: **Site Settings → Environment Variables → Add variable**
  - Key: `NTFY_TOPIC`
  - Value: your topic ID from the dashboard (e.g. `rcb-tickets-abc1234`)
- **Trigger a redeploy** after adding the env var

## How it works
The Netlify scheduled function (`netlify/functions/check-tickets.mjs`) runs every 2 minutes and:
1. Fetches rcb.in, rcb.in/matches, rcb.in/tickets
2. Scans HTML for ticket-related keywords (book tickets, buy now, bookmyshow, etc.)
3. If 2+ keywords found → sends urgent push via ntfy.sh to your phone
4. Sends a silent log ping to `{topic}-log` channel so you can verify it's running

## Files
```
rcb-monitor/
├── netlify.toml                        # Netlify config
├── package.json
├── public/
│   └── index.html                      # Dashboard + setup guide
└── netlify/functions/
    └── check-tickets.mjs               # Scheduled function (runs every 2 min)
```

## Environment Variables
| Variable | Description |
|----------|-------------|
| `NTFY_TOPIC` | Your unique ntfy topic ID (get it from the dashboard) |

## Test notifications
The dashboard has a **"Send Test Notification"** button — use it to verify your phone receives alerts before the match.
