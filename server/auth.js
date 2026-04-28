'use strict';
const ldap   = require('ldapjs');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// -- Local users file path -----------------------------------------------------
const USERS_FILE = path.join(__dirname, 'users.json');

// -- LDAP configuration --------------------------------------------------------
// Leave LDAP_URL empty ('') to disable LDAP and use local users instead
const LDAP_URL        = 'ldaps://yourdomainldaps:636';                  // your LDAPS address (leave empty to use local auth)
const LDAP_BASE_DN    = 'DC=contoso,DC=com';                            // your base distinguished name
const LDAP_SVC_DN     = 'CN=USERNAME,OU=OU,OU=OU,DC=contoso,DC=com';   // service user DN for directory read
const LDAP_SVC_PASS   = 'USERPASSWORD';                                 // service user password
const LDAP_GROUP_DN   = 'CN=GROUPNAME,OU=OU,OU=OU,DC=contoso,DC=com';  // authorized group distinguished name
const LDAP_GROUP_NAME = 'GROUPNAME';                                    // authorized group CN

// -- Detect authentication mode ------------------------------------------------
const USE_LDAP = LDAP_URL.trim() !== '';
console.log(`[auth] Mode: ${USE_LDAP ? 'LDAPs (' + LDAP_URL + ')' : 'Local users'}`);

// -- Session store (in-memory) -------------------------------------------------
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function createSession(username) {
  const token   = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { username, expires });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s;
}

function deleteSession(token) {
  sessions.delete(token);
}

// Cleanup expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now > s.expires) sessions.delete(token);
  }
}, 60 * 60 * 1000);

// -- Local authentication ------------------------------------------------------

// Hash a password with SHA-256 + salt (stored as salt:hash)
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.createHmac('sha256', s).update(password).digest('hex');
  return { hash: `${s}:${h}`, salt: s };
}

function verifyPassword(password, stored) {
  const [salt] = stored.split(':');
  const { hash } = hashPassword(password, salt);
  return hash === stored;
}

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch { return []; }
}

async function localAuthenticate(username, password) {
  if (!username || !password) throw new Error('Credenziali mancanti');
  const users = loadUsers();
  if (!users.length) throw new Error('Nessun utente configurato. Esegui: npm run add-user');
  const user = users.find(u => u.username === username);
  if (!user) throw new Error('Utente non trovato');
  if (!verifyPassword(password, user.password)) throw new Error('Password non corretta');
  return { ok: true, username };
}

// -- LDAPs authentication ------------------------------------------------------

// ldapjs v3 does not expose escapeFilter - manual implementation RFC 4515
function escapeFilter(s) {
  return String(s)
    .replace(/\\/g, '\\5c')
    .replace(/\*/g,  '\\2a')
    .replace(/\(/g,  '\\28')
    .replace(/\)/g,  '\\29')
    .replace(/\0/g,  '\\00');
}

// Create LDAP client with TLS
function createClient() {
  return ldap.createClient({
    url:            LDAP_URL,
    tlsOptions:     { rejectUnauthorized: false },
    reconnect:      false,
    connectTimeout: 5000,
    timeout:        8000,
  });
}

// Promisified LDAP bind
function ldapBind(client, dn, password) {
  return new Promise((resolve, reject) => {
    client.bind(dn, password, (err) => err ? reject(err) : resolve());
  });
}

// Promisified LDAP search
function ldapSearch(client, base, options) {
  return new Promise((resolve, reject) => {
    client.search(base, options, (err, res) => {
      if (err) return reject(err);
      const entries = [];
      res.on('searchEntry', entry => {
        // ldapjs v3: data is in entry.attributes (array of LdapAttribute)
        const obj = { _dn: entry.dn ? entry.dn.toString() : '' };
        if (entry.attributes) {
          for (const attr of entry.attributes) {
            const name = attr.type || attr._type;
            const vals = attr.values || attr._vals || [];
            obj[name] = vals.length === 1 ? vals[0] : vals;
          }
        }
        entries.push(obj);
      });
      res.on('error', e => reject(e));
      res.on('end',   () => resolve(entries));
    });
  });
}

// Main LDAP authentication function: verify credentials and group membership
async function ldapAuthenticate(username, password) {
  if (!username || !password) throw new Error('Credenziali mancanti');

  const client = createClient();

  try {
    // Step 1: bind as service user to search for the user DN
    await ldapBind(client, LDAP_SVC_DN, LDAP_SVC_PASS);

    const entries = await ldapSearch(client, LDAP_BASE_DN, {
      scope:      'sub',
      filter:     `(sAMAccountName=${escapeFilter(username)})`,
      attributes: ['dn', 'sAMAccountName', 'memberOf'],
    });

    if (!entries.length) throw new Error('Utente non trovato');
    const userEntry = entries[0];
    const userDN    = userEntry._dn;

    // Step 2: bind as the user to verify password
    await ldapBind(client, userDN, password);

    // Step 3: check group membership via memberOf attribute
    const memberOf = userEntry.memberOf || [];
    const groups   = Array.isArray(memberOf) ? memberOf : [memberOf];
    const inGroup  = groups.some(g => g.toLowerCase() === LDAP_GROUP_DN.toLowerCase());

    if (!inGroup) {
      // Fallback: search the group directly for the user as member
      const groupEntries = await ldapSearch(client, LDAP_BASE_DN, {
        scope:      'sub',
        filter:     `(&(objectClass=group)(cn=${LDAP_GROUP_NAME})(member=${userDN}))`,
        attributes: ['dn'],
      });
      if (!groupEntries.length) throw new Error(`Utente non autorizzato: non appartiene al gruppo ${LDAP_GROUP_NAME}`);
    }

    return { ok: true, username };

  } finally {
    try { client.unbind(); } catch {}
    client.destroy();
  }
}

// -- Unified authenticate function ---------------------------------------------
async function authenticate(username, password) {
  if (USE_LDAP) {
    return ldapAuthenticate(username, password);
  } else {
    return localAuthenticate(username, password);
  }
}

// -- Express middleware: protect all routes except public ones -----------------
function authMiddleware(req, res, next) {
  const publicPaths = ['/login', '/css/', '/js/', '/fonts/', '/api/auth/login', '/api/auth/logout'];
  if (publicPaths.some(p => req.path.startsWith(p))) return next();

  const token   = req.cookies && req.cookies.cms_session;
  const session = getSession(token);
  if (!session) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Non autenticato' });
    return res.redirect('/login');
  }
  req.user = session.username;
  next();
}

module.exports = { authenticate, authMiddleware, createSession, deleteSession, getSession, hashPassword };
