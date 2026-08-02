# Phoenix Leave & Attendance Portal — real backend

This is the real, persistent version of the leave portal: a Node.js server backed by an actual
database file, replacing the earlier single-HTML-file prototype. Every leave request, approval,
notification and approver assignment is now written to disk and survives restarts. The look and
feel is identical to the prototype you already reviewed — only the plumbing underneath changed.

## What's in here

- `src/` — the Express server: authentication, leave requests, approvals, admin settings, the
  team calendar, and the printable certificate — all reading and writing to a real SQLite
  database (`data/leave.db`).
- `public/` — the front end (HTML/CSS/JS) staff actually see in their browser. Same design as
  before; it now calls the server's API instead of holding data in memory.
- `data/leave.db` — the database itself. This one file *is* your company's leave records. Back
  it up regularly (see below).

The real 26-person Phoenix roster, departments, holidays and the approver chains you configured
are loaded in automatically the first time the server starts. After that, everything (new leave
requests, approver changes you make in Admin settings, entitlement edits) lives in the database
and is never re-seeded or overwritten by a restart.

## Running it locally (to try it out)

Requires Node.js 22.5 or newer (uses Node's built-in SQLite, so there's nothing extra to install
or compile).

```
npm install
cp .env.example .env
npm start
```

Then open `http://localhost:3000`. Sign in with any employee's email (e.g.
`cmelnick@phoenixintl.co.za` for Craig). Since `SMTP_HOST` isn't set in `.env` by default, the
login code won't actually be emailed — it'll show up directly on the sign-in screen labelled
"Dev mode", and in the server's console. That's only for trying it out; see below for turning on
real emails.

## Turning on real email

The one-time login code is sent by email — free, and everyone already has a company inbox, so
there's nothing extra to install. To make it real, fill in the `SMTP_*` values in `.env` with
the SMTP details for wherever `@phoenixintl.co.za` mailboxes are hosted (Google Workspace,
Microsoft 365, or whoever manages that currently) or a transactional email service like Postmark,
SendGrid or Mailgun if preferred. Once `SMTP_HOST` is set, real emails go out automatically and
the on-screen dev code disappears. Setting `NODE_ENV=production` makes this mandatory — the app
will refuse to start faking codes once you're live.

## Deploying it for real, independent of Virtual Designs

Since the goal is to run this yourselves rather than depend on your current web developer, the
cleanest approach is to host it on its own small server under an account you control, and link
to it from the WordPress site's menu — the main site itself doesn't need to change at all.

Two straightforward, low-cost options that both support the persistent disk this app needs for
its database file:

**Railway** (usage-based pricing, roughly from $5/month for something this size) — connect this
folder as a GitHub repo, add a volume for the `data/` folder, set the environment variables from
`.env.example` in its dashboard, and it deploys automatically on every push.

**Render** (flat per-service pricing, from about $7/month, plus a small charge per GB for the
persistent disk) — same idea: point it at the repo, attach a persistent disk mounted at `/data`,
set `DB_PATH=/data/leave.db`, and set the same environment variables.

Either way, once it's live you'll get a URL like `phoenix-leave.up.railway.app`. Point a
subdomain you own — e.g. `leave.phoenixintl.co.za` — at it with a CNAME record in your DNS, and
add a link to that address in the WordPress site's navigation menu (a two-minute edit, no plugin
or developer needed). Your public site keeps running exactly as it does today.

A VPS (e.g. DigitalOcean, from about $6/month) is a third option if you'd rather have full
control of the machine yourself, at the cost of having to manage updates and backups by hand —
Railway or Render are the lower-maintenance choice for a team this size.

## Backing up your data

`data/leave.db` is the entire database. Copy that one file somewhere safe on a schedule (daily is
plenty for 26 people) — most hosts (Railway, Render) also offer automatic disk snapshots you can
turn on. There's nothing else to back up.

## What only the CEO can do

Per your requirement, approver assignments and individual leave balances are gated server-side,
not just hidden in the interface — someone would have to actually be signed in as the CEO
account to view or change them, no matter what they try in the browser.

## Automatic leave-year rollover

Every 1 March at 00:05, the server automatically resets everyone's used/pending leave to zero for
the new leave year and logs any forfeited balance to the audit trail (no carry-over, per your
policy). You can also trigger this manually as the CEO via
`POST /api/admin/rollover-leave-year` if you ever need to run it by hand.

## Adding or removing staff later

As the CEO, `GET/POST /api/admin/employees` lets you add a new starter (name, email, department,
entitlement) directly to the real roster without redeploying anything. There's no screen for this
in the UI yet — for now it's an API call your developer (or Claude, in a future session) can wire
a form up to whenever you're ready.
