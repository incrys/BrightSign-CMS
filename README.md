# BrightSign CMS

A lightweight web-based CMS for managing BrightSign media players.
Allows uploading files, monitoring player status, and controlling playback — without relying on BrightAuthor.

---

## Features

- Multi-player management from a single interface
- File upload to SD card with free space check
- Real-time player status monitoring (model, firmware, uptime, storage)
- UDP command sending
- BAC playlist visualization (read-only)
- LDAPs authentication with Active Directory group-based access control
- Session management (8-hour expiry)

---

## Requirements

- Node.js >= 18
- npm
- BrightSign player with DWS (Diagnostic Web Server) enabled
- Active Directory with LDAPs enabled (port 636)

---

## Installation

```bash
# Clone the repository
git clone https://github.com/incrys/BrightSign-CMS.git
cd brightsign-cms

# Install dependencies
npm install
```

---

## Configuration

### 1. Authentication Mode

BrightSign CMS supports two authentication modes:

| Mode | When to use |
|------|-------------|
| **LDAPs** | You have an Active Directory domain controller |
| **Local users** | Standalone installation, no domain controller |

The mode is selected automatically: if `LDAP_URL` is set in `server/auth.js`, LDAPs is used. If left empty (`''`), local users are used instead.

---

### 1a. LDAP Authentication

Edit `server/auth.js` and fill in your environment values:

```js
const LDAP_URL        = 'ldaps://yourdomainldaps:636';                  // your LDAPS address
const LDAP_BASE_DN    = 'DC=contoso,DC=com';                            // your base distinguished name
const LDAP_SVC_DN     = 'CN=USERNAME,OU=OU,OU=OU,DC=contoso,DC=com';   // service user DN for directory read
const LDAP_SVC_PASS   = 'USERPASSWORD';                                 // service user password
const LDAP_GROUP_DN   = 'CN=GROUPNAME,OU=OU,OU=OU,DC=contoso,DC=com';  // authorized group distinguished name
const LDAP_GROUP_NAME = 'GROUPNAME';                                    // authorized group CN
```

Only users belonging to the specified AD group will be able to access the portal.

---

### 1b. Local Authentication

Leave `LDAP_URL` empty in `server/auth.js`:

```js
const LDAP_URL = ''; // local auth
```

Then add users via the CLI:

```bash
# Add a user (interactive)
npm run add-user

# List all users
npm run add-user -- --list

# Remove a user
npm run add-user -- --remove username
```

Passwords are stored hashed (SHA-256 + salt) in `server/users.json`.
Add `server/users.json` to `.gitignore` to avoid committing credentials.

### 2. Port

The server runs on port `4000` by default. To change it, edit `server/index.js`:

```js
const PORT = process.env.PORT || 4000;
```

Or set the environment variable before starting:

```bash
PORT=8080 npm start
```

---

## Running

```bash
npm start
```

Or with PM2 for production:

```bash
pm2 start server/index.js --name brightsign-cms
pm2 save
```

The portal will be available at `http://localhost:4000`.

---

## First Run

On first launch, `server/players.json` will be created automatically.
Add your first player by clicking the **+** button in the sidebar and entering:

- **Name** — a friendly display name
- **IP** — the player's IP address
- **DWS Password** — the Diagnostic Web Server password set on the player

---

## Security Notes

- Authentication is handled via LDAPs (port 636, TLS encrypted)
- Sessions are stored in memory and expire after 8 hours
- It is recommended to expose the portal over HTTPS using a reverse proxy (e.g. nginx) to protect credentials in transit on the local network

---

## Project Structure

```
brightsign-cms/
├── public/
│   ├── css/
│   │   └── style.css
│   ├── js/
│   │   └── app.js
│   ├── index.html
│   └── login.html
├── server/
│   ├── auth.js              # LDAPs authentication
│   ├── cms-autorun.js       # autorun.brs generator
│   ├── autorun.template.brs # BrightScript template
│   ├── index.js             # Express server
│   └── players.json         # Player list (auto-created, not tracked by git)
├── package.json
└── README.md
```

---

[![Donate PayPal](https://img.shields.io/badge/Donate-PayPal-blue?style=for-the-badge&logo=paypal)](https://paypal.me/incrys)

## License

MIT
