'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const authRoutes = require('./routes/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security: warn loudly if JWT_SECRET is the insecure default in production ─
if (process.env.NODE_ENV === 'production' &&
    !process.env.JWT_SECRET) {
  console.warn(
    '[WARN] JWT_SECRET is not set via environment variable. ' +
    'Set it in your Render dashboard or Docker environment before going live.'
  );
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  // In production scope CORS to the Render domain; open for local dev
  origin: process.env.ALLOWED_ORIGIN || '*',
}));
app.use(express.json());

// ── Serve frontend static files ───────────────────────────────────────────────
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);

// ── Root → serve login page ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'login.html'));
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[TCP Simulator] Server running at http://0.0.0.0:${PORT}`);
  console.log(`[TCP Simulator] NODE_ENV = ${process.env.NODE_ENV || 'development'}`);
  console.log(`[TCP Simulator] JWT_SECRET source = ${process.env.JWT_SECRET ? 'environment' : 'fallback default'}`);
});
