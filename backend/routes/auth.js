'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const fs       = require('fs');
const path     = require('path');

const { verifyToken, getSecret } = require('../middleware/auth');

const router   = express.Router();
const DB_PATH  = path.join(__dirname, '..', 'data', 'users.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

function readUsers() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2), 'utf8');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongPassword(password) {
  // At least 6 characters
  return typeof password === 'string' && password.length >= 6;
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validation
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const users = readUsers();

    // Check duplicate email
    const existing = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Hash password
    const salt         = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Save user
    const newUser = {
      id:           Date.now().toString(),
      name:         name.trim(),
      email:        email.toLowerCase().trim(),
      passwordHash,
      createdAt:    new Date().toISOString(),
    };
    users.push(newUser);
    writeUsers(users);

    // Issue token
    const token = jwt.sign(
      { id: newUser.id, name: newUser.name, email: newUser.email },
      getSecret(),
      { expiresIn: '7d' }
    );

    return res.status(201).json({
      message: 'Account created successfully.',
      token,
      user: { id: newUser.id, name: newUser.name, email: newUser.email },
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const users = readUsers();
    const user  = users.find(u => u.email.toLowerCase() === email.toLowerCase().trim());

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email },
      getSecret(),
      { expiresIn: '7d' }
    );

    return res.status(200).json({
      message: 'Login successful.',
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ── GET /api/auth/me — protected route, returns current user ──────────────────
router.get('/me', verifyToken, (req, res) => {
  return res.status(200).json({
    user: { id: req.user.id, name: req.user.name, email: req.user.email },
  });
});

// ── POST /api/auth/logout — client-side token removal (stateless) ─────────────
router.post('/logout', verifyToken, (req, res) => {
  return res.status(200).json({ message: 'Logged out successfully.' });
});

module.exports = router;
