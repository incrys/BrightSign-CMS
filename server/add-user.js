#!/usr/bin/env node
'use strict';
/**
 * BrightSign CMS - Local user management
 * Usage:
 *   npm run add-user              -> interactive prompt
 *   npm run add-user -- --list    -> list all users
 *   npm run add-user -- --remove username -> remove a user
 */

const fs      = require('fs');
const path    = require('path');
const readline = require('readline');
const { hashPassword } = require('./auth');

const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch { return []; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  const args = process.argv.slice(2);

  // List users
  if (args.includes('--list')) {
    const users = loadUsers();
    if (!users.length) {
      console.log('No users configured.');
    } else {
      console.log('Configured users:');
      users.forEach(u => console.log(`  - ${u.username}`));
    }
    return;
  }

  // Remove user
  const removeIdx = args.indexOf('--remove');
  if (removeIdx !== -1) {
    const username = args[removeIdx + 1];
    if (!username) { console.error('Usage: npm run add-user -- --remove <username>'); process.exit(1); }
    const users = loadUsers();
    const filtered = users.filter(u => u.username !== username);
    if (filtered.length === users.length) {
      console.error(`User "${username}" not found.`);
      process.exit(1);
    }
    saveUsers(filtered);
    console.log(`User "${username}" removed.`);
    return;
  }

  // Add user (interactive)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const username = (await ask(rl, 'Username: ')).trim();
    if (!username) { console.error('Username cannot be empty.'); process.exit(1); }

    const password = (await ask(rl, 'Password: ')).trim();
    if (!password) { console.error('Password cannot be empty.'); process.exit(1); }

    if (password.length < 8) {
      console.error('Password must be at least 8 characters.');
      process.exit(1);
    }

    const users = loadUsers();
    if (users.some(u => u.username === username)) {
      console.error(`User "${username}" already exists. Remove it first with --remove.`);
      process.exit(1);
    }

    const { hash } = hashPassword(password);
    users.push({ username, password: hash });
    saveUsers(users);
    console.log(`User "${username}" added successfully.`);
  } finally {
    rl.close();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
